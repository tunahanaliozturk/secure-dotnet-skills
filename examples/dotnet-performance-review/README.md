# Example: dotnet-performance-review

A worked review of a `ProductSummaryHandler` that combines three common performance defects: sync-over-async (`.Result`), a per-call `new HttpClient()`, and double enumeration of an `IEnumerable<Product>`.

> **Measure first.** The fixes below eliminate objectively wasteful patterns (blocking threads, exhausting sockets, executing the same query twice). Before addressing subtler micro-optimizations, collect a profiler trace or BenchmarkDotNet run to confirm where time is actually spent — intuition about hot paths is frequently wrong.

---

## BEFORE — defective handler

```csharp
// ProductSummaryHandler.cs
public class ProductSummaryHandler
{
    private readonly AppDbContext _db;
    private readonly IConfiguration _config;

    public ProductSummaryHandler(AppDbContext db, IConfiguration config)
    {
        _db = db;
        _config = config;
    }

    public ProductSummaryResult Handle(int categoryId)
    {
        // BUG 1 — sync-over-async: blocks a thread-pool thread waiting on the Task.
        // In ASP.NET Core this does not deadlock (no single-threaded sync context),
        // but it wastes a thread for the entire I/O duration and reduces throughput.
        IEnumerable<Product> products = _db.Products
            .Where(p => p.CategoryId == categoryId)
            .AsEnumerable()
            .ToList()
            .GetEnumerator()
            // Simpler but identical anti-pattern:
            as IEnumerable<Product>;

        // Realistic sync-over-async: a service that wraps async work
        var pricingUrl = _config["Pricing:BaseUrl"];
        string json;
        using (var client = new HttpClient())   // BUG 2 — new HttpClient() per call
        {
            // .Result blocks the calling thread synchronously
            json = client.GetStringAsync($"{pricingUrl}/api/prices/{categoryId}").Result;
        }

        var prices = System.Text.Json.JsonSerializer.Deserialize<Dictionary<int, decimal>>(json,
            new System.Text.Json.JsonSerializerOptions { PropertyNameCaseInsensitive = true }); // BUG 3 note: new options each call

        // BUG 3 — IEnumerable enumerated twice from the database query
        // First enumeration: count
        var count = products.Count();   // executes the query (or iterates the collection) once

        // Second enumeration: project to summary
        var items = products             // iterates again — if products were IQueryable<T>, this
            .Select(p => new ProductSummaryItem(  // would fire a second round-trip to the DB
                p.Id,
                p.Name,
                prices.GetValueOrDefault(p.Id)))
            .ToList();

        return new ProductSummaryResult(count, items);
    }
}
```

---

## Findings

| # | Location | Impact | Finding | Why it matters |
|---|----------|--------|---------|----------------|
| 1 | `client.GetStringAsync(...).Result` | **High** | Sync-over-async — `.Result` blocks a thread | Wastes a thread-pool thread for the full I/O round-trip. Under load this starves the thread pool and increases latency for all concurrent requests. Even without deadlock, throughput degrades linearly with blocking time. |
| 2 | `new HttpClient()` inside `using` | **High** | Per-call `HttpClient` construction — socket exhaustion | Each `HttpClient` opens new TCP connections. The `using` disposes the client but the underlying socket lingers in `TIME_WAIT` (up to 4 minutes on most OS configs). Under moderate traffic, ephemeral ports are exhausted. Use `IHttpClientFactory`. |
| 3 | `products.Count()` then `products.Select(…)` | **Medium** | Double enumeration of `IEnumerable<Product>` | If `products` is a deferred `IQueryable<T>`, each call fires a separate SQL query. Even as a materialized `List<T>`, iterating twice is wasteful and signals a misunderstanding of enumeration semantics. Materialize once and reuse. |
| 4 | `new JsonSerializerOptions { … }` per call | **Medium** | Fresh `JsonSerializerOptions` on every call | `JsonSerializerOptions` caches reflection metadata internally. Constructing a new instance per call rebuilds that metadata each time — measurable overhead at high request rates. Use a `static readonly` instance or `IOptions<JsonSerializerOptions>`. |

---

## AFTER — fixed handler

```csharp
// ProductSummaryHandler.cs
public class ProductSummaryHandler
{
    // FIX 4 — single static options instance; metadata compiled once
    private static readonly JsonSerializerOptions _jsonOptions = new()
    {
        PropertyNameCaseInsensitive = true
    };

    private readonly AppDbContext _db;
    private readonly HttpClient _pricingClient;   // FIX 2 — typed client injected by IHttpClientFactory

    public ProductSummaryHandler(AppDbContext db, HttpClient pricingClient)
    {
        _db = db;
        _pricingClient = pricingClient;
    }

    // FIX 1 — async all the way; no .Result or .Wait()
    public async Task<ProductSummaryResult> HandleAsync(
        int categoryId,
        CancellationToken ct = default)
    {
        // FIX 3 — materialize once; reuse the list for both count and projection
        var products = await _db.Products
            .Where(p => p.CategoryId == categoryId)
            .Select(p => new { p.Id, p.Name })   // project to DTO — don't over-fetch columns
            .ToListAsync(ct);                     // single DB round-trip

        // FIX 1 — await the HTTP call instead of blocking
        var json = await _pricingClient.GetStringAsync(
            $"api/prices/{categoryId}", ct);

        // FIX 4 — reuse static options; no metadata recompilation
        var prices = JsonSerializer.Deserialize<Dictionary<int, decimal>>(json, _jsonOptions)
            ?? new Dictionary<int, decimal>();

        // FIX 3 — count and project from the already-materialized list (no second DB hit)
        var count = products.Count;   // List<T>.Count is O(1), no enumeration

        var items = products
            .Select(p => new ProductSummaryItem(
                p.Id,
                p.Name,
                prices.GetValueOrDefault(p.Id)))
            .ToList();

        return new ProductSummaryResult(count, items);
    }
}
```

### DI registration (Program.cs)

```csharp
// FIX 2 — register a typed client; IHttpClientFactory manages handler lifetime and pooling
builder.Services.AddHttpClient<ProductSummaryHandler>(client =>
{
    client.BaseAddress = new Uri(builder.Configuration["Pricing:BaseUrl"]!);
    client.Timeout = TimeSpan.FromSeconds(5);
});

// Register the handler itself as a scoped service
builder.Services.AddScoped<ProductSummaryHandler>();
```

---

## Why each fix works

**Fix 1 — async all the way (`await` vs `.Result`):**
`.Result` blocks the calling thread for the duration of the HTTP call. Under load, with many concurrent requests each blocking a thread, the thread pool exhausts its budget and begins throttling. `await` releases the thread back to the pool during I/O so it can serve other requests. The deadlock risk is context-dependent (ASP.NET Core does not have the classic single-threaded sync context that made `.Result` deadlock in classic ASP.NET), but the throughput cost is real in both environments.

**Fix 2 — `IHttpClientFactory` typed client:**
`AddHttpClient<T>` registers a typed client whose underlying `SocketsHttpHandler` is managed by the factory with a configurable lifetime (default 2 minutes). The factory rotates handlers to respect DNS TTLs while pooling and reusing TCP connections within the active handler window. `new HttpClient()` + `using` creates and discards a handler on every call — sockets enter `TIME_WAIT` and accumulate until the OS evicts them.

**Fix 3 — single materialization, `List<T>.Count`:**
`products.Count()` on an `IQueryable<T>` fires `SELECT COUNT(*)` against the database; a subsequent `foreach` fires the full `SELECT`. By calling `.ToListAsync()` once and using `List<T>.Count` (an O(1) property read, not an extension method), both the count and the projection work against an in-memory list — one DB round-trip total.

**Fix 4 — `static readonly JsonSerializerOptions`:**
`JsonSerializerOptions` internally caches type converters and reflection metadata. Each `new JsonSerializerOptions()` cold-starts that cache. A `static readonly` instance amortizes the initialization cost across all calls. In ASP.NET Core, the framework's registered `JsonSerializerOptions` (via `builder.Services.Configure<JsonOptions>(...)`) should be preferred over a hand-rolled static when the handler runs inside the request pipeline.

---

## Measure before going further

The four fixes above remove objectively harmful patterns. If further optimization is needed after these are applied, measure with a profiler before proceeding:

- **BenchmarkDotNet** for micro-benchmarks of serialization or enumeration logic in isolation.
- **`dotnet-trace` / `dotnet-counters`** for live thread-pool saturation (`ThreadPool.Queue.Length`), GC allocation rate (`gc-alloc-rate`), and working-set growth under load.
- **Visual Studio Diagnostic Tools** or **JetBrains dotMemory** for allocation heap snapshots to find unexpected boxing or closure captures.

Speculation about additional hot spots (e.g., switching to `Span<T>`, replacing LINQ with manual loops) should be driven by profiler evidence, not assumption.
