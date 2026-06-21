---
name: resilience-review
description: Use when reviewing how a .NET service handles transient faults and downstream failures — timeouts, retries, circuit breakers, bulkheads, and fallback — for calls to databases, queues, and HTTP dependencies.
---

# Resilience Review

Directs the agent to audit every outbound dependency of a .NET service against concrete resilience patterns — timeouts, retry policies, circuit breakers, bulkheads, fallback, and cancellation propagation — and produce findings linked to real APIs and configuration options.

## When to use

- A service has been reported as hanging or slow to fail when a downstream HTTP API, database, or queue is unavailable or degraded.
- A PR introduces or modifies calls to external HTTP endpoints, EF Core `DbContext` operations, or Azure Service Bus / Storage clients.
- A service lacks `Microsoft.Extensions.Http.Resilience` or Polly v8 policies and needs them added before production hardening.
- A post-incident review identified cascading failures caused by a missing circuit breaker or unbounded retry storm.
- A reliability or SLO review requires verifying that every outbound call has a bounded timeout and backoff.

## Process

1. **Map the outbound dependencies.** Enumerate every outbound call: HTTP endpoints (typed clients, `HttpClient`), EF Core / SQL, Azure Service Bus / Storage / Key Vault, Redis / `IDistributedCache`, and any gRPC or message-queue producers. Record each dependency's latency profile and failure mode (transient vs permanent).
2. **Confirm per-attempt and total timeouts.** For each dependency, verify there is both a per-attempt timeout (bounding a single request) and an overall deadline / total timeout (bounding all retries combined). A call with only a per-attempt timeout can still block indefinitely if retries are unbounded.
3. **Review the retry policy.** Check that retries target only idempotent operations and transient faults (`HttpRequestException`, HTTP 5xx, 408 Request Timeout), honor `429 Too Many Requests` with a `Retry-After` delay, use exponential backoff with jitter to prevent thundering herd, and cap the attempt count.
4. **Review circuit breaker and bulkhead isolation.** Confirm a circuit breaker is configured on known-flaky dependencies to stop retry storms when the target is down. Confirm a bulkhead (concurrency limiter) isolates each slow dependency so it cannot exhaust the shared thread pool or connection pool.
5. **Review fallback and graceful degradation.** For each dependency, confirm there is a defined fallback: a cached response, a default/empty result, a degraded mode, or a clear propagation of the `503` upstream — not a swallowed exception that silently returns stale or corrupt data.
6. **Check cancellation propagation.** Verify `CancellationToken` is accepted and forwarded through every layer — controller action → service → `HttpClient` call / EF Core query / queue operation. Deadlines set on an outer `HttpContext.RequestAborted` or `CancellationTokenSource.CreateLinkedTokenSource` must flow to every I/O call.
7. **Output findings.** For each dependency with a gap, provide: the specific missing policy, the concrete API fix (`AddStandardResilienceHandler()`, `ResiliencePipelineBuilder`, `EnableRetryOnFailure`), and the idempotency precondition that must be met before enabling retries.

## .NET / Azure checks

- **`Microsoft.Extensions.Http.Resilience` — `AddStandardResilienceHandler()`.** Register on typed clients with `builder.Services.AddHttpClient<TClient>().AddStandardResilienceHandler()`. The standard handler composes — in order — a total request timeout, a retry with exponential backoff + jitter, a circuit breaker, an attempt timeout, and a hedging option. Override defaults via `HttpStandardResilienceOptions`: `TotalRequestTimeout.Timeout`, `Retry.MaxRetryAttempts`, `Retry.BackoffType = DelayBackoffType.Exponential`, `CircuitBreaker.SamplingDuration`, `AttemptTimeout.Timeout`. For custom pipelines use `AddResilienceHandler("name", builder => { ... })` with a `ResiliencePipelineBuilder<HttpResponseMessage>`.
- **Polly v8 `ResiliencePipelineBuilder`.** Polly v8 replaces `Policy.Handle<T>()` (v7) with `new ResiliencePipelineBuilder().AddRetry(...).AddCircuitBreaker(...).AddTimeout(...).Build()`. Register pipelines with `builder.Services.AddResiliencePipeline("key", builder => { ... })` and resolve via `ResiliencePipelineProvider<string>`. Strategies are composed in execution order: outermost strategy executes first.
- **Per-attempt timeout AND total timeout.** A per-attempt timeout (`TimeoutStrategyOptions { Timeout = TimeSpan.FromSeconds(2) }`) bounds a single attempt. A total timeout / deadline (`TotalRequestTimeout` in `HttpStandardResilienceOptions`, or an outer `AddTimeout` wrapping the retry strategy) bounds the entire retry sequence. Without a total timeout, three retries of a 2-second attempt timeout can still consume 6+ seconds; with jitter and backoff, indefinitely longer.
- **Retries only for idempotent operations and transient faults.** Configure `ShouldHandle` to match `HttpRequestException`, HTTP 5xx, and 408. Honor `429 Too Many Requests`: inspect `Retry-After` via `RetryStrategyOptions.OnRetry` and delay accordingly — use `args.Response?.Headers.RetryAfter` to parse the value. Use exponential backoff with jitter: `DelayBackoffType.Exponential` with `UseJitter = true`. Cap attempts: `MaxRetryAttempts = 3` (or 4 total including the first attempt). Do not retry non-idempotent POSTs (payment creation, order submission) without an idempotency key that makes re-submission safe.
- **Circuit breaker.** Configure `AddCircuitBreaker` with `FailureRatio`, `SamplingDuration`, `MinimumThroughput`, and `BreakDuration`. A half-open probe is automatic. Without a circuit breaker, a downed dependency receives full retry traffic from every in-flight request simultaneously, amplifying load on recovery and blocking threads/connections for the break duration.
- **Bulkhead / concurrency limiter.** Add `AddConcurrencyLimiter(maxConcurrentCalls, queueDepth)` to isolate a slow dependency. Without it, a dependency that starts taking 30 s per call will saturate the thread pool as requests queue up awaiting completion. Pair with `IHttpClientFactory`'s `PooledConnectionLifetime` to prevent stale DNS entries.
- **Fallback strategy.** Use `AddFallback(new FallbackStrategyOptions<HttpResponseMessage> { FallbackAction = ... })` to return a cached or default response when all retries and the circuit breaker have been exhausted. Cache the last-known-good response in `IMemoryCache` / `IDistributedCache` and serve it on fallback. For write paths, enqueue to a durable outbox or return a `503` with a `Retry-After` header rather than silently dropping the operation.
- **`CancellationToken` end-to-end.** Every async method in the call chain must accept and forward `CancellationToken`. For HTTP calls, pass `ct` to `GetAsync` / `SendAsync`. For EF Core, pass `ct` to `ToListAsync`, `FirstOrDefaultAsync`, `SaveChangesAsync`. For Azure SDK clients (`BlobClient`, `ServiceBusClient`), pass `cancellationToken`. Use `CancellationTokenSource.CreateLinkedTokenSource(requestAbortedToken, timeoutToken)` to combine an HTTP request abort with a hard deadline.
- **`IHttpClientFactory` typed clients — not `new HttpClient()`.** Register with `builder.Services.AddHttpClient<TPaymentClient, PaymentClient>(client => { client.BaseAddress = ...; })`. The factory pools `SocketsHttpHandler` instances, rotating them on `HandlerLifetime` (default 2 min) to respect DNS TTLs. `new HttpClient()` per call creates a new handler with no connection reuse; sockets accumulate in `TIME_WAIT`.
- **EF Core `EnableRetryOnFailure`.** Configure in `DbContextOptionsBuilder`: `options.UseSqlServer(conn, sql => sql.EnableRetryOnFailure(maxRetryCount: 5, maxRetryDelay: TimeSpan.FromSeconds(30), errorNumbersToAdd: null))`. The built-in strategy retries on SQL transient errors (connection failures, timeouts, deadlocks). For Azure SQL / SQL MI, the default error list covers transient connectivity faults. Do not call `EnableRetryOnFailure` and then also wrap EF calls in a Polly retry — double-retry can cause excessive attempts.
- **Idempotency as a retry precondition.** Before enabling retry on any operation, confirm the operation is idempotent or made idempotent with an idempotency key. GET, HEAD, PUT, and DELETE are semantically idempotent. POST is not — wrap payment-creation, order-submission, or any side-effectful POST in an `Idempotency-Key` that the server deduplicates before enabling retry on the client.

## Red flags

| Signal | Why it matters |
|--------|----------------|
| `HttpClient` call with no `Timeout` and no `CancellationToken` | The call can block indefinitely if the server stops responding; threads accumulate and the thread pool starves. Always set `client.Timeout` or pass a `CancellationToken` with a deadline. |
| Retry applied to a non-idempotent POST without an idempotency key | Retrying payment creation or order submission can cause duplicate charges or duplicate records. Confirm idempotency first. |
| `while (retries-- > 0)` hand-rolled retry loop with `Task.Delay` | No jitter, no backoff calibration, no circuit-breaker integration, no `CancellationToken` support, and no standard observability hooks. Replace with Polly v8 `ResiliencePipelineBuilder` or `AddStandardResilienceHandler()`. |
| Infinite or unbounded `MaxRetryAttempts` | A loop retrying indefinitely against a downed dependency holds connections and threads for the service's entire uptime. Cap at 3–5 attempts with a total timeout. |
| Retries with no backoff (fixed or zero delay) | Synchronized retry waves from many concurrent callers hit the recovering dependency simultaneously — thundering herd. Use `DelayBackoffType.Exponential` with `UseJitter = true`. |
| No circuit breaker on a known-flaky dependency | When the target is down, every in-flight request retries to exhaustion before failing; the circuit breaker stops this within one `SamplingDuration` window and allows the dependency to recover. |
| `catch (Exception) { return null; }` swallowing all errors | Turns dependency failures into silent data corruption — callers receive a null or default response with no indication that the call failed. Propagate or convert to a structured fallback with logging. |
| `new HttpClient()` per request or per method call | No handler pooling; TCP sockets linger in `TIME_WAIT`, exhausting ephemeral ports under moderate traffic. Register via `IHttpClientFactory`. |
| Missing `EnableRetryOnFailure` on EF Core with Azure SQL | Transient SQL connectivity errors (error 40613, 40197, 49918) are common on Azure SQL; without retry-on-failure, a transient fault surfaces as an unhandled exception. |
| Polly v7 `Policy.Handle<T>().WaitAndRetry(...)` in a new .NET 8+ project | Polly v7 policies are not pipeline-composable with `IHttpClientFactory`'s resilience extension; v8 `ResiliencePipelineBuilder` / `Microsoft.Extensions.Http.Resilience` is the current standard and integrates with `IServiceCollection`. |

## Example

See [`examples/resilience-review/`](../../examples/resilience-review/).

## Related skills

- [dotnet-performance-review](../dotnet-performance-review/SKILL.md) — overlapping concern: `IHttpClientFactory`, connection pooling, and async/IO patterns affect both performance and resilience.
- [async-concurrency-review](../async-concurrency-review/SKILL.md) — `CancellationToken` propagation, `Task.WhenAll` fan-out, and thread-pool health are reviewed in depth there.
