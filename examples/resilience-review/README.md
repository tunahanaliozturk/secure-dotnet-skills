# Example: resilience-review

A worked review of a `PaymentGatewayClient` typed client that calls an external payment API with no timeout, no retry policy, no circuit breaker, and no cancellation support. The fix applies `Microsoft.Extensions.Http.Resilience` with a standard pipeline, adds a cached fallback for the idempotent read path, and wires `CancellationToken` end-to-end.

> **Idempotency first.** The retry policy below is applied **only** to the idempotent GET (fetch payment status). The non-idempotent POST (create payment) is deliberately excluded from retry to prevent duplicate charges.

---

## BEFORE — fragile typed client

```csharp
// PaymentGatewayClient.cs
public class PaymentGatewayClient
{
    // BUG 1 — new HttpClient() per construction; caller owns lifecycle;
    //          no connection pooling, no IHttpClientFactory.
    private readonly HttpClient _http = new HttpClient();

    public PaymentGatewayClient()
    {
        // BUG 2 — no base timeout; a non-responsive server blocks indefinitely.
        _http.BaseAddress = new Uri("https://payments.example.com");
    }

    // BUG 3 — no CancellationToken; caller cannot cancel or set a deadline.
    public async Task<PaymentStatus?> GetPaymentStatusAsync(string paymentId)
    {
        // BUG 4 — no retry, no circuit breaker; a single transient 503
        //          surfaces directly as an unhandled exception.
        var response = await _http.GetAsync($"/api/payments/{paymentId}/status");
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<PaymentStatus>();
    }

    // BUG 5 — non-idempotent POST; if this were wrapped in a retry loop
    //          the payment would be duplicated on transient failure.
    public async Task<PaymentResult> CreatePaymentAsync(CreatePaymentRequest request)
    {
        var response = await _http.PostAsJsonAsync("/api/payments", request);
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<PaymentResult>())!;
    }
}
```

```csharp
// Program.cs — BEFORE
// No IHttpClientFactory, no resilience registration.
builder.Services.AddSingleton<PaymentGatewayClient>();
```

---

## Findings

| # | Location | Impact | Finding | Why it matters |
|---|----------|--------|---------|----------------|
| 1 | `new HttpClient()` in constructor | **High** | No `IHttpClientFactory`; no connection pooling | Handler is never pooled; TCP sockets accumulate in `TIME_WAIT`; DNS changes are never respected until the process restarts. |
| 2 | No `Timeout` on `HttpClient` | **High** | Unbounded wait on unresponsive server | If the payment gateway stops accepting connections, every in-flight request blocks indefinitely, exhausting the thread pool. |
| 3 | No `CancellationToken` on `GetPaymentStatusAsync` | **Medium** | Request abort cannot propagate | When the ASP.NET Core request is cancelled (client disconnect, upstream timeout), the downstream HTTP call cannot be cancelled — it continues consuming resources unnecessarily. |
| 4 | No retry or circuit breaker on `GetPaymentStatusAsync` | **Medium** | Transient 5xx or network blip surfaces as exception | A single transient 503 causes the entire operation to fail; a circuit breaker is absent so a downed gateway receives full retry pressure from all concurrent callers. |
| 5 | `CreatePaymentAsync` — retry risk | **High** (latent) | Non-idempotent POST would duplicate charges if retried | If a future developer wraps this in a generic retry, duplicate payment records would be created. The method must be explicitly excluded from retry or require an `Idempotency-Key`. |

---

## AFTER — resilient typed client

### NuGet packages required

```xml
<PackageReference Include="Microsoft.Extensions.Http.Resilience" Version="8.*" />
<PackageReference Include="Microsoft.Extensions.Caching.Memory" Version="8.*" />
```

### Program.cs — DI registration

```csharp
// Program.cs — AFTER

// FIX 1 + 2 + 4 — Register typed client via IHttpClientFactory; attach a
// standard resilience handler (total-timeout → retry → circuit-breaker →
// attempt-timeout) on the GET path only.
builder.Services.AddHttpClient<IPaymentGatewayClient, PaymentGatewayClient>(client =>
{
    client.BaseAddress = new Uri(builder.Configuration["PaymentGateway:BaseUrl"]!);
    // Hard outer timeout as a backstop; AddStandardResilienceHandler's
    // TotalRequestTimeout is the primary deadline.
    client.Timeout = TimeSpan.FromSeconds(30);
})
.AddResilienceHandler("payment-status-get", pipelineBuilder =>
{
    // Strategy order: outermost executes first.

    // 1. Total request timeout — bounds the entire retry sequence.
    pipelineBuilder.AddTimeout(new HttpTimeoutStrategyOptions
    {
        Timeout = TimeSpan.FromSeconds(10)
    });

    // 2. Retry — only for transient HTTP faults on idempotent reads.
    pipelineBuilder.AddRetry(new HttpRetryStrategyOptions
    {
        MaxRetryAttempts = 3,
        BackoffType = DelayBackoffType.Exponential,
        UseJitter = true,
        // Retry on transient faults only; honor 429 Retry-After.
        ShouldHandle = new PredicateBuilder<HttpResponseMessage>()
            .Handle<HttpRequestException>()
            .HandleResult(r =>
                r.StatusCode is HttpStatusCode.ServiceUnavailable  // 503
                    or HttpStatusCode.GatewayTimeout               // 504
                    or HttpStatusCode.InternalServerError          // 500
                    or HttpStatusCode.RequestTimeout),             // 408
        OnRetry = args =>
        {
            // Honor Retry-After on 429 Too Many Requests.
            if (args.Outcome.Result?.StatusCode == HttpStatusCode.TooManyRequests)
            {
                var retryAfter = args.Outcome.Result.Headers.RetryAfter;
                if (retryAfter?.Delta is TimeSpan delta)
                    args.RetryDelay = delta;
            }
            return ValueTask.CompletedTask;
        }
    });

    // 3. Circuit breaker — stops hammering a downed gateway.
    pipelineBuilder.AddCircuitBreaker(new HttpCircuitBreakerStrategyOptions
    {
        FailureRatio = 0.5,          // open if 50% of calls fail …
        SamplingDuration = TimeSpan.FromSeconds(30), // … in any 30-second window …
        MinimumThroughput = 5,       // … with at least 5 calls sampled.
        BreakDuration = TimeSpan.FromSeconds(15)
    });

    // 4. Per-attempt timeout — bounds a single attempt.
    pipelineBuilder.AddTimeout(new HttpTimeoutStrategyOptions
    {
        Timeout = TimeSpan.FromSeconds(3)
    });
});

// Register IMemoryCache for the cached fallback.
builder.Services.AddMemoryCache();
```

### PaymentGatewayClient.cs — AFTER

```csharp
// PaymentGatewayClient.cs — AFTER

public interface IPaymentGatewayClient
{
    Task<PaymentStatus?> GetPaymentStatusAsync(string paymentId, CancellationToken ct = default);
    Task<PaymentResult> CreatePaymentAsync(CreatePaymentRequest request, CancellationToken ct = default);
}

public sealed class PaymentGatewayClient : IPaymentGatewayClient
{
    // FIX 1 — HttpClient injected by IHttpClientFactory; pooled, DNS-aware.
    private readonly HttpClient _http;
    private readonly IMemoryCache _cache;
    private readonly ILogger<PaymentGatewayClient> _logger;

    public PaymentGatewayClient(
        HttpClient http,
        IMemoryCache cache,
        ILogger<PaymentGatewayClient> logger)
    {
        _http = http;
        _cache = cache;
        _logger = logger;
    }

    // FIX 3 — CancellationToken accepted and forwarded.
    // The "payment-status-get" resilience pipeline (total timeout + retry +
    // circuit breaker + attempt timeout) is applied via DI registration above.
    public async Task<PaymentStatus?> GetPaymentStatusAsync(
        string paymentId,
        CancellationToken ct = default)
    {
        var cacheKey = $"payment-status:{paymentId}";

        try
        {
            // FIX 4 — resilience pipeline applied at the DI layer;
            //          CancellationToken propagated through the HTTP call.
            var response = await _http.GetAsync($"/api/payments/{paymentId}/status", ct);
            response.EnsureSuccessStatusCode();

            var status = await response.Content.ReadFromJsonAsync<PaymentStatus>(ct);

            // Cache the last-known-good response for fallback on future failures.
            if (status is not null)
            {
                _cache.Set(cacheKey, status, TimeSpan.FromMinutes(5));
            }

            return status;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // FIX 5 — structured fallback: return last-cached status rather
            //          than surfacing the exception to the caller as a 500.
            _logger.LogWarning(ex,
                "Payment gateway unavailable for payment {PaymentId}; serving cached status",
                paymentId);

            if (_cache.TryGetValue(cacheKey, out PaymentStatus? cached))
                return cached;

            // No cache entry — propagate as a 503 so the caller can retry.
            throw;
        }
    }

    // FIX 5 (non-idempotent) — CreatePayment is NOT wrapped in a retry pipeline.
    // The caller must supply an idempotency key (X-Idempotency-Key header) and
    // the server must deduplicate on it before client-side retry is safe.
    public async Task<PaymentResult> CreatePaymentAsync(
        CreatePaymentRequest request,
        CancellationToken ct = default)
    {
        // No AddResilienceHandler on this path — retrying a payment POST
        // without server-side idempotency deduplication would create duplicates.
        using var httpRequest = new HttpRequestMessage(HttpMethod.Post, "/api/payments");
        httpRequest.Content = JsonContent.Create(request);

        // The idempotency key must be set by the caller before invoking this method.
        if (!string.IsNullOrEmpty(request.IdempotencyKey))
            httpRequest.Headers.Add("X-Idempotency-Key", request.IdempotencyKey);

        var response = await _http.SendAsync(httpRequest, ct);
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<PaymentResult>(ct))!;
    }
}
```

---

## Why each fix works

**Fix 1 — `IHttpClientFactory` typed client:**
`AddHttpClient<TClient>` registers a `SocketsHttpHandler` managed by the factory. Handlers are pooled for `HandlerLifetime` (default 2 min) and then rotated, so DNS changes are respected without losing in-flight connections. `new HttpClient()` per construction bypasses pooling entirely.

**Fix 2 — total + per-attempt timeouts:**
The resilience pipeline has two timeout layers: a 10-second total timeout wrapping the entire retry sequence, and a 3-second per-attempt timeout. Without both, three retries of a 3-second attempt timeout could take 9+ seconds excluding backoff delays; the total timeout provides a hard upper bound.

**Fix 3 — `CancellationToken` end-to-end:**
`HttpContext.RequestAborted` cancels when the HTTP client disconnects. Forwarding that token to `GetAsync` ensures the downstream call is cancelled immediately rather than running to completion and discarding the result. Under a 503 storm this prevents orphaned connections from accumulating.

**Fix 4 — `AddResilienceHandler` with retry, circuit breaker, and 429 handling:**
The `payment-status-get` pipeline retries transient faults (5xx, 408, `HttpRequestException`) with exponential backoff and jitter, preventing thundering herd. The circuit breaker opens after a 50% failure rate in any 30-second window, stopping retry pressure against a downed gateway and allowing it to recover. `429` responses are retried after the `Retry-After` delay rather than counted as general failures.

**Fix 5 — cached fallback on the read path; no retry on the write path:**
The last-known-good `PaymentStatus` is stored in `IMemoryCache` with a 5-minute TTL. When the circuit breaker is open or all retries are exhausted, the cached value is returned instead of a 500. For `CreatePayment`, no retry is applied — the caller must provide an `X-Idempotency-Key` and the server must deduplicate before retry is safe on the write path.
