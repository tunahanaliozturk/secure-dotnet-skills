# Example: observability-review

A worked review of a `PaymentService` with three classic observability defects: a bearer token leaked via string interpolation, an exception silently discarded (logged without its object), and no correlation id in log records.

---

## BEFORE — instrumented with defects

```csharp
// PaymentService.cs
public class PaymentService
{
    private readonly ILogger<PaymentService> _logger;
    private readonly IPaymentGateway _gateway;

    public PaymentService(ILogger<PaymentService> logger, IPaymentGateway gateway)
    {
        _logger = logger;
        _gateway = gateway;
    }

    public async Task<PaymentResult> ChargeAsync(string token, decimal amount, Guid orderId)
    {
        // DEFECT 1 — string interpolation leaks the bearer token verbatim.
        // Structured properties are lost; "token" is a raw string in every log sink.
        _logger.LogInformation($"Charging order {orderId} with token {token} for {amount:C}");

        try
        {
            var result = await _gateway.ChargeAsync(token, amount);
            _logger.LogInformation($"Payment succeeded for order {orderId}");
            return result;
        }
        catch (Exception)
        {
            // DEFECT 2 — exception object is discarded entirely.
            // No type, message, or stack trace reaches the sink.
            // No correlation id ties this log line to the current request span.
            _logger.LogError("Payment failed");
            return PaymentResult.Failed;
        }
    }
}
```

```csharp
// Program.cs — no OTel, no health checks, no log scope middleware
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers();
// No builder.Services.AddOpenTelemetry()
// No builder.Services.AddHealthChecks()
// Console-only logging (the default)
```

---

## Findings

| # | Location | Severity | Finding | Why it matters |
|---|----------|----------|---------|----------------|
| 1 | `PaymentService.ChargeAsync` line 16 | **Critical** | Bearer token emitted verbatim via `$"…{token}…"` | String interpolation bypasses all MEL structured-property hooks. The token appears as plain text in every sink (console, Application Insights, OTLP) with no redaction opportunity. Any developer or log-aggregation operator with read access to logs can replay the token. |
| 2 | `PaymentService.ChargeAsync` line 25 | **High** | `LogError("Payment failed")` discards the exception object | The caught `Exception` is never passed to the logger. No sink receives the exception type, message, or stack trace — the only diagnostic signal is the bare string "Payment failed". Root-cause investigation requires guessing. |
| 3 | `Program.cs` | **High** | No OTel pipeline, no `BeginScope`, no correlation id in log records | Log lines from the same request cannot be correlated with each other or with a distributed trace. Incident investigation requires manual grep across timestamps. |
| 4 | `Program.cs` | **Medium** | No `AddHealthChecks()` registration | Kubernetes / Azure Container Apps has no liveness or readiness signal; a hung process is never restarted and a dependency-failing replica continues to receive traffic. |
| 5 | `Program.cs` | **Medium** | Console-only sink in production | Console output is ephemeral and not queryable. No alerting, retention, or structured search. |

---

## AFTER — fixed instrumentation

```csharp
// PaymentService.cs
public class PaymentService
{
    private readonly ILogger<PaymentService> _logger;
    private readonly IPaymentGateway _gateway;

    public PaymentService(ILogger<PaymentService> logger, IPaymentGateway gateway)
    {
        _logger = logger;
        _gateway = gateway;
    }

    public async Task<PaymentResult> ChargeAsync(string token, decimal amount, Guid orderId)
    {
        // FIX 1 — named-placeholder template: structured properties are preserved in
        // every sink and are queryable. The token is replaced with a redacted hint
        // (last 4 chars only) — never log the full token.
        var tokenHint = token.Length > 4 ? $"***{token[^4..]}" : "***";
        _logger.LogInformation(
            "Charging order {OrderId} (token hint {TokenHint}) for {Amount}",
            orderId, tokenHint, amount);

        try
        {
            var result = await _gateway.ChargeAsync(token, amount);
            _logger.LogInformation("Payment succeeded for order {OrderId}", orderId);
            return result;
        }
        catch (Exception ex)
        {
            // FIX 2 — exception object passed as the first argument.
            // MEL serialises type, message, and stack trace as structured fields.
            // Named placeholder {OrderId} ties the record to the order.
            _logger.LogError(ex, "Payment processing failed for order {OrderId}", orderId);
            return PaymentResult.Failed;
        }
    }
}
```

```csharp
// Program.cs — OTel, health checks, Azure Monitor exporter
using OpenTelemetry.Logs;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

var builder = WebApplication.CreateBuilder(args);

// FIX 3 — OpenTelemetry pipeline with W3C trace-context propagation.
// AddSource must match the ActivitySource name(s) used in the application.
// The OTel log bridge automatically injects TraceId / SpanId into every log record,
// correlating logs and traces in Application Insights and Log Analytics without
// a manual BeginScope call.
builder.Services.AddOpenTelemetry()
    .ConfigureResource(r => r.AddService("PaymentApi"))
    .WithTracing(tracing => tracing
        .AddSource("PaymentApi.*")
        .AddAspNetCoreInstrumentation()
        .AddHttpClientInstrumentation()
        .AddAzureMonitorTraceExporter())   // connection string from config / Key Vault
    .WithMetrics(metrics => metrics
        .AddMeter("PaymentApi.*")
        .AddAspNetCoreInstrumentation()
        .AddAzureMonitorMetricExporter());

// Log bridge: routes ILogger records through OTel so TraceId / SpanId are injected.
builder.Logging.AddOpenTelemetry(logging =>
{
    logging.IncludeScopes = true;
    logging.AddAzureMonitorLogExporter();
});

// FIX 4 — health checks with EF Core check and a readiness / liveness split.
builder.Services.AddHealthChecks()
    .AddDbContextCheck<AppDbContext>(); // from Microsoft.Extensions.Diagnostics.HealthChecks.EntityFrameworkCore

builder.Services.AddControllers();

var app = builder.Build();

app.MapHealthChecks("/health/live",
    new HealthCheckOptions { Predicate = _ => false });  // liveness: process alive
app.MapHealthChecks("/health/ready");                    // readiness: dependencies up
app.MapControllers();
app.Run();
```

```csharp
// Custom activity example — always use 'using' to guarantee the span is completed.
public static class Telemetry
{
    public static readonly ActivitySource Source = new("PaymentApi.Payment");
}

// In a handler or service:
using var activity = Telemetry.Source.StartActivity("ChargeCard", ActivityKind.Client);
activity?.SetTag("order.id", orderId);
// Never set activity?.SetTag("card.token", token) — PII / secret.
```

---

### Why each fix works

**Fix 1 — token leakage** (string interpolation → named-placeholder template with redaction):
`$"…{token}…"` calls `token.ToString()` before MEL sees the value, producing a single opaque string. A named-placeholder template keeps each argument as a typed value that MEL (and sinks such as Serilog or Application Insights) can serialise, mask, or redact. By replacing the full token with a last-4-chars hint before logging, the secret never enters the telemetry pipeline at all.

**Fix 2 — silent exception** (`LogError("…")` → `LogError(ex, "…")`):
The `ILogger` overload `LogError(Exception? exception, string? message, params object?[] args)` serialises the exception as a structured field. Application Insights records it as `exceptions` telemetry; OTLP exporters attach it as an event with `exception.type`, `exception.message`, and `exception.stacktrace` attributes per the OTel semantic conventions. Without the `ex` argument, these fields are absent and the stack trace is permanently lost.

**Fix 3 — correlation** (OTel log bridge + `AddAspNetCoreInstrumentation`):
The OTel log bridge (`AddOpenTelemetry(logging => logging.AddAzureMonitorLogExporter())`) intercepts every `ILogger` record and stamps it with the active `Activity`'s `TraceId` and `SpanId` before export. ASP.NET Core instrumentation (`AddAspNetCoreInstrumentation`) starts a root span for each inbound HTTP request, so every log line emitted within a request handler carries the same trace-id — queries in Application Insights / Log Analytics can join traces and logs with a single `where operation_Id == "…"` filter.

**Fix 4 — health checks**:
`AddHealthChecks().AddDbContextCheck<AppDbContext>()` probes the database connection on each `/health/ready` poll. The split into `/health/live` (always returns `Healthy` if the process runs) and `/health/ready` (checks dependencies) allows Kubernetes to distinguish a crashed process (restart it) from a temporarily-overloaded process (stop routing traffic without restarting).
