---
name: rate-limiting-review
description: Use when reviewing rate limiting and overload protection in an ASP.NET Core app — limiter algorithm, partitioning, 429 semantics, and where limiting belongs — to protect against abuse and overload.
---

# Rate-Limiting Review

Directs the agent to audit the rate-limiting and overload-protection strategy in an ASP.NET Core service: algorithm selection, partition key safety, rejection semantics, per-endpoint coverage, and the boundary between app-level and gateway-level enforcement.

## When to use

- An ASP.NET Core service exposes anonymous or expensive endpoints that could be abused or scraped.
- A login or auth endpoint has no brute-force protection.
- Rate limiting is present but uses raw IP as the partition key, returns 503 instead of 429, or has no `Retry-After` header.
- The service runs behind a load balancer or in a multi-instance deployment and you need to decide whether in-memory limiting is sufficient.
- A new service is being designed and you need to choose between app-level middleware and gateway enforcement (APIM / Azure Front Door).

## Process

1. **Identify the resources to protect and the threat model.** Categorise each endpoint: expensive (search, AI inference, report generation), sensitive (login, password reset, MFA), anonymous (no auth required), and health/probe endpoints. Note whether the service is publicly routable or internal.
2. **Choose the algorithm for each protected resource.** Match the algorithm to the access pattern: fixed window for simple per-minute caps, sliding window to smooth burst traffic, token bucket for steady throughput with tolerated bursts, concurrency limiter to cap in-flight requests to a slow downstream.
3. **Choose the partition key.** Prefer authenticated identity (API key, `ClaimsPrincipal` user ID, tenant ID) over IP address. Raw IP behind a NAT or load balancer collapses many clients into a single bucket; using it on a multi-tenant endpoint unfairly penalises entire office networks.
4. **Set rejection semantics.** Verify that rejected requests return `429 Too Many Requests` (not the default `503`), carry a `Retry-After` header, and that queue limits and ordering are intentional.
5. **Decide gateway vs app placement and per-instance vs distributed.** An in-memory limiter enforces limits per-instance — on a horizontally scaled deployment each instance allows its own quota, so the effective global limit is `quota × instance count`. For a global limit, use a distributed limiter (Redis-backed) or push enforcement to the gateway (APIM rate policies, Azure Front Door WAF rules, or both).
6. **Output findings.** For each gap, name the concrete API to add or fix, the partition key to use, the algorithm, and whether gateway enforcement is needed in addition to or instead of app-level middleware.

## .NET / Azure checks

- **Registration:** `builder.Services.AddRateLimiter(options => { … })` + `app.UseRateLimiter()` (the middleware is in `Microsoft.AspNetCore.RateLimiting`, shipped with ASP.NET Core 7+; no extra NuGet package needed). Confirm `UseRateLimiter()` appears in the pipeline before route-matching middleware.
- **Algorithm selection:**
  - `FixedWindowRateLimiterOptions` — simple per-window request cap; susceptible to edge-of-window burst (two windows back-to-back double the rate).
  - `SlidingWindowRateLimiterOptions` — smooths the burst by tracking sub-segments within the window.
  - `TokenBucketRateLimiterOptions` — tokens refill at a fixed rate; supports controlled bursts up to `TokenLimit`; best for expensive operations (search, AI calls).
  - `ConcurrencyLimiterOptions` — caps the number of in-flight requests; useful for slow downstream calls where request duration is the binding constraint.
- **Partitioning:** All built-in algorithms use `RateLimitPartition.GetFixedWindowLimiter(partitionKey, factory)` (or `Get*Limiter`) from `System.Threading.RateLimiting`. The `partitionKey` must identify an authenticated client — API key extracted from a request header, `httpContext.User.FindFirstValue(ClaimTypes.NameIdentifier)`, or tenant ID — not `httpContext.Connection.RemoteIpAddress`. Partitioning by raw IP is incorrect when:
  - The service is behind a reverse proxy or load balancer (all connections originate from the proxy's IP).
  - The service runs in Azure (traffic arrives from Front Door or Application Gateway IPs).
- **`X-Forwarded-For` usage:** If the real client IP is genuinely needed as a fallback partition key (e.g., for fully anonymous endpoints with no API key), read it only after configuring `ForwardedHeadersOptions` with `KnownProxies` / `KnownNetworks` and calling `app.UseForwardedHeaders()`. Without this, an attacker can spoof the header by sending any value — making the limiter trivially bypassable.
- **Rejection semantics:**
  - Set `options.RejectionStatusCode = StatusCodes.Status429TooManyRequests` on `RateLimiterOptions`. The framework default is `503 Service Unavailable`, which is wrong for rate limiting (503 signals an overloaded server, not a throttled client).
  - Set `options.OnRejected` to a delegate that writes a `Retry-After` header. Example: `context.HttpContext.Response.Headers.RetryAfter = retryAfter.ToString("R");` where `retryAfter` is computed from `lease.TryGetMetadata(MetadataName.RetryAfter, out var delay)`.
  - Configure `QueueLimit` to buffer a bounded number of excess requests rather than rejecting them immediately; set `QueueProcessingOrder` to `OldestFirst` (fair) or `NewestFirst` (LIFO under load). A `QueueLimit` of 0 rejects immediately.
- **Per-endpoint policies:** Apply a named limiter with `endpoint.RequireRateLimiting("policyName")` in the route builder or `[EnableRateLimiting("policyName")]` on a controller/action. Explicitly exempt health-check endpoints with `[DisableRateLimiting]` or by not wiring them to a policy — health and readiness probes must never be throttled.
- **Coverage checklist:**
  - Login and authentication endpoints (`POST /auth/token`, `/account/login`, `/account/forgot-password`) — protect against credential stuffing and brute force.
  - Expensive anonymous endpoints (search, public AI inference, report export) — protect against cost abuse.
  - High-volume write endpoints on unauthenticated flows — protect against scraping and spam.
  - Do NOT throttle `/health`, `/ready`, `/alive`, or metrics endpoints.
- **Per-instance vs distributed:** An `AddRateLimiter` limiter lives in the ASP.NET Core process. On a deployment with N instances (Azure App Service scaled out, AKS pods), each instance applies its own independent quota — there is no cross-instance coordination. Options:
  - Use a Redis-backed sliding-window limiter (e.g. via `RedisRateLimiting` / `StackExchange.Redis`) to share state.
  - Enforce at the gateway: APIM rate-limit-by-key policy, Azure Front Door WAF rate-limit rule, or Application Gateway custom rules. This is simpler and more reliable for coarse-grained throttling.
  - Combine both: gateway for coarse global limits, app-level for fine-grained per-user policies.

## Red flags

| Signal | Why it matters |
|--------|----------------|
| No rate limiting on `POST /auth/login` or `/account/forgot-password` | Opens the service to credential stuffing and brute-force password attacks with no friction; a free-tier account can enumerate millions of credentials. |
| `partitionKey: httpContext.Connection.RemoteIpAddress` behind a load balancer | All clients share the proxy's source IP — one user exhausts the quota for every user routed through the same proxy, and an attacker behind NAT is never throttled. |
| `X-Forwarded-For` read without `ForwardedHeadersOptions`/`KnownProxies` configured | The header is attacker-controlled; a client can rotate spoofed IP values on each request and bypass the limiter completely. |
| `options.RejectionStatusCode` left at default (503) | Returns `503 Service Unavailable` instead of `429 Too Many Requests`; callers cannot distinguish a rate-limited response from a service outage, breaking retry logic. |
| `OnRejected` not set or set without a `Retry-After` header | RFC 6585 requires `Retry-After` on 429 responses; without it, well-behaved clients back off randomly or not at all, and CDNs may cache the error. |
| In-memory `AddRateLimiter` on a horizontally scaled deployment without a distributed backend | Each of N instances allows the full per-policy quota; the effective global rate is N × quota, making the limit meaningless at scale. |
| Health-check and readiness-probe endpoints throttled | Kubernetes / Azure health probes are rejected; the orchestrator marks the pod/instance unhealthy and triggers unnecessary restarts or traffic removal. |
| `QueueLimit` set to a very large value on an expensive endpoint | Queued requests consume memory and hold connections open; under a burst attack, the queue itself becomes a memory-exhaustion vector. |

## Example

See [`examples/rate-limiting-review/`](../../examples/rate-limiting-review/).

## Related skills

- [threat-model-endpoint](../threat-model-endpoint/SKILL.md) — identifies DoS and abuse threats that rate limiting mitigates.
- [api-contract-review](../api-contract-review/SKILL.md) — verifies the 429 + `Retry-After` contract is correctly modelled in the OpenAPI document and error shape.
