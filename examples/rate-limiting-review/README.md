# Rate-Limiting Review — Before / After Example

**Scenario:** A public `POST /search` endpoint runs a full-text search against a large index and optionally calls an AI ranker. The operation is expensive (CPU + downstream call) and requires no authentication. Without rate limiting, a single client can drive the service to 100 % CPU and starve all other users.

---

## BEFORE — unprotected expensive anonymous endpoint

```csharp
// Program.cs — no rate limiting registered or applied

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton<SearchService>();

var app = builder.Build();

// POST /search — open to the internet, no throttle, no auth
app.MapPost("/search", async (SearchRequest req, SearchService svc) =>
{
    var results = await svc.SearchAsync(req.Query, req.MaxResults);
    return Results.Ok(results);
});

app.Run();
```

```csharp
// SearchRequest.cs
public record SearchRequest(string Query, int MaxResults = 20);
```

**Problems:**
- Any client can issue unlimited `POST /search` requests. One abuser can exhaust CPU and connection-pool resources.
- There is no `429` response, no `Retry-After`, and no back-pressure signal to callers.
- Even a well-behaved client with a bug (e.g. a tight retry loop) can tip the service into overload.

---

## AFTER — token-bucket limiter partitioned by API key, 429 + Retry-After, RequireRateLimiting

```csharp
// Program.cs
using Microsoft.AspNetCore.RateLimiting;
using System.Threading.RateLimiting;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton<SearchService>();

// 1. Register the rate limiter with a token-bucket policy partitioned by API key.
builder.Services.AddRateLimiter(options =>
{
    // Token bucket: each API key gets 10 tokens; refills 2 tokens every 10 seconds.
    // This allows short bursts (up to 10 in-flight) while enforcing a sustained cap.
    options.AddTokenBucketLimiter("search-policy", limiterOptions =>
    {
        limiterOptions.TokenLimit = 10;
        limiterOptions.QueueLimit = 2;                          // buffer up to 2 extra requests
        limiterOptions.QueueProcessingOrder = QueueProcessingOrder.OldestFirst;
        limiterOptions.ReplenishmentPeriod = TimeSpan.FromSeconds(10);
        limiterOptions.TokensPerPeriod = 2;
        limiterOptions.AutoReplenishment = true;
    });

    // NOTE: AddTokenBucketLimiter is a global (non-partitioned) helper used here for
    // illustration. For per-API-key partitioning use AddPolicy with a custom factory:
    //   options.AddPolicy("search-policy", httpContext => { … });
    // See the partitioned variant below.

    // 2. Always return 429, never 503.
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

    // 3. Add Retry-After so clients back off correctly.
    options.OnRejected = async (context, cancellationToken) =>
    {
        if (context.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfter))
        {
            context.HttpContext.Response.Headers.RetryAfter =
                ((int)retryAfter.TotalSeconds).ToString();
        }
        else
        {
            // Fallback: tell the client to wait 10 seconds.
            context.HttpContext.Response.Headers.RetryAfter = "10";
        }

        context.HttpContext.Response.StatusCode = StatusCodes.Status429TooManyRequests;
        await context.HttpContext.Response.WriteAsync(
            "Rate limit exceeded. Please retry after the Retry-After interval.",
            cancellationToken);
    };
});

var app = builder.Build();
app.UseRateLimiter(); // must appear before UseRouting / endpoint middleware

// 4. Apply the policy only to the expensive endpoint; health checks are left unrestricted.
app.MapPost("/search", async (SearchRequest req, SearchService svc) =>
{
    var results = await svc.SearchAsync(req.Query, req.MaxResults);
    return Results.Ok(results);
}).RequireRateLimiting("search-policy");

app.MapGet("/health", () => Results.Ok()).WithMetadata(new DisableRateLimitingAttribute());

app.Run();
```

### Partitioned variant — per API key (recommended for multi-tenant APIs)

When the service issues API keys (via an `X-Api-Key` header or `Authorization` bearer token), partition the limiter so each client gets an independent bucket rather than sharing one global pool:

```csharp
builder.Services.AddRateLimiter(options =>
{
    options.AddPolicy("search-policy", httpContext =>
    {
        // Extract the partition key from an authenticated identity or API key header.
        // Never use httpContext.Connection.RemoteIpAddress behind a load balancer.
        var apiKey = httpContext.Request.Headers["X-Api-Key"].ToString();

        // Fall back to a shared anonymous bucket if no key is present.
        // Tighten the anonymous bucket (fewer tokens) to discourage keyless calls.
        var partitionKey = string.IsNullOrWhiteSpace(apiKey) ? "__anonymous__" : apiKey;
        var tokenLimit = string.IsNullOrWhiteSpace(apiKey) ? 3 : 10;

        return RateLimitPartition.GetTokenBucketLimiter(
            partitionKey,
            _ => new TokenBucketRateLimiterOptions
            {
                TokenLimit = tokenLimit,
                QueueLimit = 0,                          // reject immediately, no queue
                ReplenishmentPeriod = TimeSpan.FromSeconds(10),
                TokensPerPeriod = string.IsNullOrWhiteSpace(apiKey) ? 1 : 2,
                AutoReplenishment = true,
            });
    });

    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

    options.OnRejected = async (context, cancellationToken) =>
    {
        context.HttpContext.Response.Headers.RetryAfter =
            context.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfter)
                ? ((int)retryAfter.TotalSeconds).ToString()
                : "10";

        context.HttpContext.Response.StatusCode = StatusCodes.Status429TooManyRequests;
        await context.HttpContext.Response.WriteAsync(
            "Rate limit exceeded.", cancellationToken);
    };
});
```

### Key decisions captured

| Decision | BEFORE | AFTER |
|----------|--------|-------|
| Algorithm | None | Token bucket — allows controlled burst, enforces sustained cap |
| Partition key | N/A | API key (per-client isolation, not shared raw IP) |
| Rejection status | N/A | `429 Too Many Requests` (explicit; default would be 503) |
| `Retry-After` header | None | Set via `OnRejected` using `MetadataName.RetryAfter` |
| Queue | N/A | `QueueLimit = 2`, `OldestFirst` (fair drain under burst) |
| Health check | N/A | `[DisableRateLimiting]` — probes never throttled |
| Scale consideration | N/A | For N > 1 instances, back this with a Redis-partitioned limiter or push coarse limits to APIM / Azure Front Door |
