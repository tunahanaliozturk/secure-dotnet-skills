---
name: observability-review
description: Use when reviewing logging, tracing, and metrics in a .NET app — structured logging, OpenTelemetry, correlation, and avoiding PII / secret leakage in telemetry.
---

# Observability Review

Directs the agent to audit a .NET / ASP.NET Core service's logging, distributed tracing, and metrics instrumentation lens by lens — verifying structured-logging hygiene, OpenTelemetry wiring, correlation-id propagation, PII/secret redaction, and health-check coverage, then producing concrete fixes using real MEL and OTel APIs.

## When to use

- A PR adds or changes logging, tracing, or metrics instrumentation in a .NET service.
- A service has no correlation id, logs are hard to correlate across requests, or spans are missing from traces.
- A production incident reveals that log lines contain tokens, passwords, or user PII, or that exceptions are logged without their stack traces.
- Adding OpenTelemetry (`AddOpenTelemetry`) or migrating from a legacy logging sink to OTLP / Application Insights / Log Analytics.

## Process

1. **Inventory the observability setup.** Locate `Program.cs` / `Startup.cs` for `AddLogging`, `AddOpenTelemetry`, and `AddHealthChecks` registrations. Note which sinks are configured (Application Insights, OTLP exporter, console, Seq, etc.), which `LogLevel` minimums are set per category, and whether a sampling strategy is in place.
2. **Check structured-logging usage.** Search the codebase for `_logger.Log…` calls. Flag every call that uses C# string interpolation (`$"…"`) instead of a named-placeholder message template. Confirm exceptions are always passed as the first argument to `LogError`/`LogCritical` — not swallowed or stringified. Confirm `LogWarning` / `LogError` are not used for informational events in hot paths.
3. **Check trace and correlation-id propagation.** Confirm `AddOpenTelemetry().WithTracing(…)` is configured and includes the correct sources via `AddSource`. Verify W3C `traceparent`/`tracestate` headers are propagated for inbound HTTP (`AddAspNetCoreInstrumentation`) and outbound HTTP (`AddHttpClientInstrumentation`). Confirm the current trace-id / span-id is available in log scope (via `BeginScope` or the OTel log bridge) so log lines and trace spans are correlated in the sink.
4. **Check what is logged — levels, PII, and secrets.** Scan for log messages that include tokens, passwords, keys, connection-string fragments, or user-identifying fields (email, national ID, credit card). Confirm no full request or response bodies are logged without scrubbing. Verify that sampling is configured (at the OTel `Sampler` level or the sink level) so debug-level events do not flood production telemetry.
5. **Check metrics and health.** Confirm business-critical signals are measured with `Meter` / `Counter<T>` / `Histogram<T>` (RED pattern: Rate, Errors, Duration). Verify `AddHealthChecks()` is wired and at least one liveness / readiness check is registered. Confirm the OTel metrics pipeline (`WithMetrics(…)`) exports to the same sink as traces and logs.
6. **Recommend improvements with precise APIs.** For each finding name the exact fix: swap `$"…"` for a named-placeholder template; replace `LogError("failed")` with `LogError(ex, "…")`; add `Activity.Current?.TraceId` to a `BeginScope` dictionary; register `AddAzureMonitorTraceExporter` / `AddOtlpExporter`. Generic advice ("add more logging") is not a finding.

## .NET / Azure checks

- **Structured-logging message templates with named placeholders.** Every `ILogger` call must use a constant template string with named, positionally-bound placeholders: `_logger.LogInformation("User {UserId} created order {OrderId}", userId, orderId)`. The placeholder names become searchable properties in the sink; the arguments are bound positionally in order. Never use C# string interpolation — `_logger.LogInformation($"User {userId} created order {orderId}")` — because the resulting string is a single opaque value: structured properties are lost, the message cannot be grouped or queried, and sensitive values (tokens, PII) are captured in plain text with no redaction hook.

- **Exceptions passed to `LogError` / `LogCritical` as the first argument.** Logging `catch (Exception ex) { _logger.LogError("Payment failed"); }` discards the exception type, message, and stack trace. The correct call is `_logger.LogError(ex, "Payment processing failed for order {OrderId}", orderId)`: MEL overloads accept `Exception exception` as the first parameter, and sinks (Serilog, Application Insights, OTLP) serialise it as a structured exception object, not a formatted string. A `catch` block that does not pass `ex` to the logger is always a defect.

- **Appropriate log levels; no chatty `Information` in hot paths.** `LogInformation` in a loop that executes per row, per message, or per request inflates ingestion costs and makes noise in production. Reserve `Information` for coarse-grained request lifecycle events; use `LogDebug` or `LogTrace` for detail that is normally filtered out. Confirm `appsettings.Production.json` sets `"Default"` minimum to `Warning` or `Information` — never `Debug` — and that per-category overrides are intentional.

- **OpenTelemetry tracing wired with `AddOpenTelemetry().WithTracing(…)`.** `builder.Services.AddOpenTelemetry().WithTracing(tracing => tracing.AddSource("MyApp.*").AddAspNetCoreInstrumentation().AddHttpClientInstrumentation().AddOtlpExporter())` is the standard registration pattern. Verify `AddSource` names match the `ActivitySource` instance names used in the application. An `ActivitySource` not listed in `AddSource` produces spans that are silently ignored. Custom spans must be started with `_activitySource.StartActivity("OperationName", ActivityKind.Internal)` and disposed in a `using` block so they are always completed.

- **W3C trace-context propagation.** Confirm the OTel `TextMapPropagator` includes `TraceContextPropagator` (the default in `OpenTelemetry.Api` 1.x). For outbound gRPC or HTTP calls that use a custom `HttpClient`, verify the `AddHttpClientInstrumentation()` injection is present — without it, the `traceparent` header is not forwarded and cross-service traces are broken. For service-bus / queue consumers, propagate the context manually via `Propagators.DefaultTextMapPropagator.Extract`.

- **Trace-id and span-id in log scope.** Logs and traces are only correlated in a sink (Application Insights, Log Analytics, Loki) if the current trace-id is present in the log record. With the OTel log bridge (`AddOpenTelemetryLoggerProvider`) this happens automatically. Without it, emit the ids explicitly: `using (_logger.BeginScope(new Dictionary<string, object> { ["TraceId"] = Activity.Current?.TraceId.ToString() ?? "", ["SpanId"] = Activity.Current?.SpanId.ToString() ?? "" })) { … }` at the start of each request handler or via a middleware.

- **No PII, secrets, or tokens in log messages or trace attributes.** Search log calls for arguments that are email addresses, national identifiers, credit-card numbers, passwords, bearer tokens, API keys, or connection-string fragments. Flag any `span.SetTag("user.email", email)` or `_logger.LogInformation("Token: {Token}", token)`. Apply redaction at the source: pass only an identifier or hash, never the raw value. For Application Insights, configure a `TelemetryInitializer` to scrub known property names. For OTel, use a custom `BaseProcessor<Activity>` to redact attributes before export.

- **Sampling strategy.** Confirm a sampler is configured — `AlwaysOnSampler` in production is acceptable only for low-volume services; for high-throughput services use `TraceIdRatioBasedSampler` or a tail-sampling proxy. An unsampled production environment with `AlwaysOn` generates trace data proportional to request volume, which can be expensive and can also inadvertently sample PII-carrying spans at 100%.

- **Metrics via `Meter` / `Counter<T>` / `Histogram<T>` and RED signals.** For each key operation (requests processed, payment attempts, queue messages consumed) define at least: a `Counter<long>` for throughput (Rate), a `Counter<long>` for error count (Errors), and a `Histogram<double>` for latency in milliseconds (Duration). Register `builder.Services.AddOpenTelemetry().WithMetrics(metrics => metrics.AddMeter("MyApp.*").AddAspNetCoreInstrumentation().AddOtlpExporter())`. Avoid ad-hoc `Gauge` reads of mutable static fields — prefer `ObservableGauge<T>` with a callback.

- **`AddHealthChecks()` with liveness and readiness probes.** `builder.Services.AddHealthChecks()` with at minimum `AddDbContextCheck<AppDbContext>()` (EF Core health check) and any downstream dependency checks. Map two endpoints: `app.MapHealthChecks("/health/live", new HealthCheckOptions { Predicate = _ => false })` (liveness — just proves the process is running) and `app.MapHealthChecks("/health/ready")` (readiness — checks dependencies). A service with no health checks is invisible to orchestrators and load balancers.

- **Centralized sink wired and log provider registered.** For Azure, `AddAzureMonitorTraceExporter` / `AddAzureMonitorLogExporter` / `AddAzureMonitorMetricExporter` (from `Azure.Monitor.OpenTelemetry.Exporter`) or the Application Insights SDK (`AddApplicationInsightsTelemetry`) must be registered. For OTLP targets, `AddOtlpExporter` with `OtlpExportProtocol.Grpc` or `HttpProtobuf`. A service that writes only to console in production has no queryable telemetry. Confirm the connection string / OTLP endpoint is read from configuration (not hardcoded) and stored in Key Vault or an environment variable.

## Red flags

| Signal | Why it matters |
|--------|----------------|
| `_logger.LogInformation($"User {userId} token {token}")` | String interpolation produces a single opaque string: structured properties are lost and the token is captured verbatim with no redaction hook. Use a named-placeholder template and never pass the raw token. |
| `catch (Exception ex) { _logger.LogError("Payment failed"); }` | The exception object is discarded — type, message, and stack trace are silenced. The first argument to `LogError` must be `ex`: `_logger.LogError(ex, "Payment failed for order {OrderId}", orderId)`. |
| No `using` block or explicit `Dispose` on a custom `Activity` | An uncompleted span is never exported; the trace shows a gap. Always start activities in a `using` or call `.Stop()` / `.Dispose()` in `finally`. |
| `span.SetTag("user.email", email)` or PII in a log placeholder argument | PII in trace attributes is emitted to every configured exporter and may persist in the backend for months. Redact at the source; store only an opaque identifier. |
| No `AddSource("…")` call matching the application's `ActivitySource` name | Spans from that source are silently dropped by the OTel SDK. The activity is created but immediately disposed with no export — tracing appears broken with no error. |
| `AddHealthChecks()` absent or health endpoints not mapped | Kubernetes / App Service / Container Apps has no signal for liveness or readiness; a stuck process is not restarted and a dependency-failing instance continues to receive traffic. |
| `AlwaysOnSampler` on a high-throughput production service | Every request generates a trace, which multiplies ingestion costs with request volume and may capture PII-bearing spans at 100% rate. Use `TraceIdRatioBasedSampler` or a tail-sampling collector. |
| Log sink writes only to console in production | Console output is ephemeral; no structured query, alerting, or retention. Configure an OTLP exporter or Application Insights / Azure Monitor exporter. |
| `_logger.LogDebug` calls present with no minimum-level override in `appsettings.Production.json` | Debug events flow to production sinks, inflating cost and volume. Set `"Default": "Information"` or higher in the production config and gate debug logs behind `IsEnabled(LogLevel.Debug)` checks in hot loops. |
| Correlation id absent from log records (no `BeginScope` or OTel log bridge) | Log lines from the same request cannot be grouped in the sink, making incident investigation a manual grep exercise. Add the OTel log bridge or a `BeginScope` middleware that injects `TraceId` and `SpanId`. |

## Example

See [`examples/observability-review/`](../../examples/observability-review/).
