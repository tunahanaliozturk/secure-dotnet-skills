# Example: async-concurrency-review

A worked review of an `OrderProcessor` service that combines two critical async/concurrency defects: a sync-over-async `.Result` call that deadlocks in classic ASP.NET hosts and wastes threads in ASP.NET Core, and a single `DbContext` instance shared across `Task.WhenAll` branches that throws at runtime.

---

## BEFORE — defective service

```csharp
// OrderProcessor.cs
public class OrderProcessor
{
    private readonly AppDbContext _db;
    private readonly IInventoryClient _inventory;

    public OrderProcessor(AppDbContext db, IInventoryClient inventory)
    {
        _db = db;
        _inventory = inventory;
    }

    // BUG 1 — synchronous method blocking on async work.
    // In classic ASP.NET (or any host with a SynchronizationContext), calling
    // .Result here deadlocks: the continuation posted by await inside
    // ReserveStockAsync tries to resume on the captured context, but .Result
    // is already holding the only thread permitted on that context.
    // In ASP.NET Core the deadlock does not occur (no blocking sync context),
    // but the thread-pool thread is wasted for the full duration of the HTTP call.
    public bool ProcessOrder(int orderId)
    {
        var order = _db.Orders.Find(orderId);
        if (order == null) return false;

        // .Result blocks the calling thread — sync-over-async
        bool reserved = _inventory.ReserveStockAsync(order.ProductId, order.Quantity).Result;
        if (!reserved) return false;

        order.Status = OrderStatus.Confirmed;
        _db.SaveChanges();
        return true;
    }

    // BUG 2 — single _db instance (AppDbContext) shared across Task.WhenAll branches.
    // DbContext is not thread-safe. Two concurrent EF Core operations on the same
    // context instance throw:
    //   InvalidOperationException: "A second operation was started on this context
    //   instance before a previous operation completed. This is usually caused by
    //   different threads concurrently using the same instance of DbContext."
    public async Task<List<OrderSummary>> GetSummariesAsync(IEnumerable<int> orderIds)
    {
        var tasks = orderIds.Select(id =>
            // Each lambda captures the same _db — concurrent reads across Task.WhenAll
            _db.Orders
               .Where(o => o.Id == id)
               .Select(o => new OrderSummary(o.Id, o.Status))
               .FirstOrDefaultAsync());   // no CancellationToken forwarded either

        // Fires all queries concurrently on the same _db — throws at runtime
        var results = await Task.WhenAll(tasks);
        return results.Where(r => r != null).ToList()!;
    }
}
```

---

## Findings

| # | Location | Severity | Finding | Why it matters |
|---|----------|----------|---------|----------------|
| 1 | `ReserveStockAsync(...).Result` in `ProcessOrder` | **High** | Sync-over-async — `.Result` blocks a thread | In classic ASP.NET (and any host with a `SynchronizationContext`), `await` inside `ReserveStockAsync` captures the context and tries to resume on it, but `.Result` already holds the context's sole permitted thread — deadlock. In ASP.NET Core there is no blocking single-threaded context so deadlock does not occur, but a thread-pool thread is blocked for the entire I/O round-trip, degrading throughput under load. Fix: make `ProcessOrder` async and `await` the call. |
| 2 | `_db` captured across `Task.WhenAll` in `GetSummariesAsync` | **High** | `DbContext` shared across concurrent `Task.WhenAll` branches | `DbContext` is explicitly documented as not thread-safe. Concurrent EF Core operations on the same instance throw `InvalidOperationException: "A second operation was started on this context instance before a previous operation completed."` Fix: inject `IDbContextFactory<AppDbContext>` and create an independent context per parallel branch. |
| 3 | `FirstOrDefaultAsync()` with no `CancellationToken` | **Medium** | `CancellationToken` not propagated | If the HTTP request is cancelled or the host shuts down, the parallel queries continue running to completion, wasting database connections. Accept and forward a `CancellationToken`. |
| 4 | `_db.SaveChanges()` (synchronous) in `ProcessOrder` | **Low** | Synchronous EF Core save on an async-capable path | `SaveChanges()` blocks the thread. Once `ProcessOrder` is made async (Fix 1), replace with `await _db.SaveChangesAsync(ct)`. |

---

## AFTER — fixed service

```csharp
// OrderProcessor.cs
public class OrderProcessor
{
    // FIX 2 — IDbContextFactory replaces a single shared DbContext.
    // AddDbContextFactory<AppDbContext>() must be registered in Program.cs.
    // Each call to CreateDbContextAsync returns an independent context + connection.
    private readonly IDbContextFactory<AppDbContext> _dbFactory;
    private readonly IInventoryClient _inventory;

    public OrderProcessor(
        IDbContextFactory<AppDbContext> dbFactory,
        IInventoryClient inventory)
    {
        _dbFactory = dbFactory;
        _inventory = inventory;
    }

    // FIX 1 — async all the way; no .Result or .Wait().
    // Callers must be updated to `await ProcessOrderAsync(...)`.
    public async Task<bool> ProcessOrderAsync(int orderId, CancellationToken ct = default)
    {
        // Each operation gets its own scoped context — safe and explicit.
        await using var db = await _dbFactory.CreateDbContextAsync(ct);

        var order = await db.Orders.FindAsync(new object[] { orderId }, ct);
        if (order == null) return false;

        // FIX 1 — await instead of .Result
        bool reserved = await _inventory.ReserveStockAsync(
            order.ProductId, order.Quantity, ct);
        if (!reserved) return false;

        order.Status = OrderStatus.Confirmed;
        // FIX 4 — async save now that the method is async
        await db.SaveChangesAsync(ct);
        return true;
    }

    // FIX 2 — each parallel branch owns its own DbContext, created from the factory.
    // FIX 3 — CancellationToken accepted and forwarded to FirstOrDefaultAsync.
    public async Task<List<OrderSummary>> GetSummariesAsync(
        IEnumerable<int> orderIds,
        CancellationToken ct = default)
    {
        var tasks = orderIds.Select(async id =>
        {
            // Independent context per branch — no shared state across concurrent tasks.
            await using var db = await _dbFactory.CreateDbContextAsync(ct);
            return await db.Orders
                .Where(o => o.Id == id)
                .Select(o => new OrderSummary(o.Id, o.Status))
                .FirstOrDefaultAsync(ct);   // FIX 3 — token forwarded
        });

        var results = await Task.WhenAll(tasks);
        return results.Where(r => r != null).ToList()!;
    }
}
```

### DI registration (Program.cs)

```csharp
// Register the factory; AddDbContextFactory makes IDbContextFactory<AppDbContext>
// available for injection. The factory creates a new DbContext (and connection)
// on each CreateDbContextAsync call, which is exactly what parallel branches need.
builder.Services.AddDbContextFactory<AppDbContext>(options =>
    options.UseSqlServer(builder.Configuration.GetConnectionString("Default")));

// OrderProcessor is transient or scoped — it no longer holds a shared DbContext.
builder.Services.AddScoped<OrderProcessor>();
```

---

## Why each fix works

**Fix 1 — `await` instead of `.Result`:**
`.Result` blocks the calling thread for the duration of the HTTP round-trip to the inventory service. In classic ASP.NET (or any host that installs a single-threaded `SynchronizationContext`) this causes a deadlock: the continuation scheduled by `await` inside `ReserveStockAsync` needs to post back to the captured context, but the context's thread is already blocked on `.Result` — neither side can proceed. In ASP.NET Core the deadlock is avoided because ASP.NET Core does not install a blocking single-threaded context (it uses `AsyncContext` internally without blocking resumption), but the thread-pool thread is still wasted for the I/O duration. Making the method `async Task` and replacing `.Result` with `await` releases the thread back to the pool during I/O, allowing it to serve other requests concurrently.

**Fix 2 — `IDbContextFactory<AppDbContext>` for per-branch contexts:**
`DbContext` maintains internal state (change tracker, pending commands, open reader state) that is not safe for concurrent access. When two tasks call EF Core operations on the same instance simultaneously, EF Core detects the concurrent operation and throws `InvalidOperationException: "A second operation was started on this context instance before a previous operation completed. This is usually caused by different threads concurrently using the same instance of DbContext."` `IDbContextFactory<TContext>` solves this by creating a fresh, independent `DbContext` (and its own database connection from the pool) for each call to `CreateDbContextAsync`. Each parallel branch owns its context, uses it, and disposes it — no shared state across branches.

**Fix 3 — `CancellationToken` forwarded to `FirstOrDefaultAsync`:**
A `CancellationToken` accepted at the method boundary but not passed to `FirstOrDefaultAsync` (or any other async I/O call) has no effect: the database query runs to completion regardless of whether the HTTP request was cancelled or the host began shutting down. Each parallel branch holds an open database connection and thread-pool completion for the full query duration. Forwarding the token allows EF Core to cancel the in-flight command promptly via `DbCommand.CancelAsync`, releasing the connection back to the pool.

**Fix 4 — `SaveChangesAsync` instead of `SaveChanges`:**
`SaveChanges` blocks the calling thread until the database round-trip completes. On an already-async call path this wastes a thread-pool thread. `SaveChangesAsync(ct)` releases the thread during the I/O, and the `ct` parameter allows the save to be cancelled before it commits if the request is abandoned.

---

## Throttling note for `Task.WhenAll`

The fixed `GetSummariesAsync` fans out one database query per order ID with no concurrency cap. For small, bounded inputs this is fine; for a large sequence (hundreds or thousands of IDs), it can open an equivalent number of database connections simultaneously, exceeding the connection pool limit. In that case, replace the unbounded fan-out with `Parallel.ForEachAsync`:

```csharp
var summaries = new ConcurrentBag<OrderSummary>();

await Parallel.ForEachAsync(
    orderIds,
    new ParallelOptions { MaxDegreeOfParallelism = 8, CancellationToken = ct },
    async (id, innerCt) =>
    {
        await using var db = await _dbFactory.CreateDbContextAsync(innerCt);
        var summary = await db.Orders
            .Where(o => o.Id == id)
            .Select(o => new OrderSummary(o.Id, o.Status))
            .FirstOrDefaultAsync(innerCt);
        if (summary != null) summaries.Add(summary);
    });

return summaries.ToList();
```

`MaxDegreeOfParallelism = 8` caps the concurrency at eight simultaneous branches, keeping the connection pool well within its limit. `ConcurrentBag<T>` is used because `List<T>` is not thread-safe for concurrent `Add` calls.
