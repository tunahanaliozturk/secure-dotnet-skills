---
name: dotnet-performance-review
description: Use when reviewing .NET code for performance — allocations and GC pressure, async/IO misuse, hot-path LINQ, repeated enumeration, string handling, caching, and serialization.
---

# .NET Performance Review

Directs the agent to walk .NET / ASP.NET Core code through concrete performance lenses — allocations, async/IO, enumeration, caching, and serialization — identifying high-impact issues and recommending measurement before any micro-optimization.

## When to use

- A request handler, background service, or library method is reported as slow or high-allocation under load.
- A PR adds or changes LINQ queries, serialization, caching, or HTTP client usage in a hot path.
- A profiler or BenchmarkDotNet run has flagged a method as a hotspot and the team needs a structured review.
- Code is being hardened for production throughput before a load test or capacity review.

## Process

1. **Identify hot paths.** Find the methods called most often or under the most load — request handlers, inner loops, serialization boundaries, and background job loops. Scope the review to those paths first; premature optimization of cold code wastes time.
2. **Audit allocations and GC pressure.** Walk each hot path for unnecessary heap allocations: string concatenation in loops, boxing of value types, closure capture, LINQ chains materializing intermediate collections, and `params` array creation.
3. **Audit async and I/O usage.** Check for sync-over-async calls (`.Result` / `.Wait()`), `async void` methods outside event handlers, missed parallelism opportunities (`Task.WhenAll`), and large result sets that should stream via `IAsyncEnumerable<T>`.
4. **Audit enumeration and LINQ.** Look for multiple enumeration of the same `IEnumerable<T>`, needless `.ToList()` / `.ToArray()` materializations used only to call `.Count`, and LINQ expressions that force client-side evaluation or generate N+1 queries.
5. **Audit caching and object reuse.** Check whether expensive repeated computations (serializer options, compiled regexes, HTTP responses) are computed fresh on every request or properly reused via `IMemoryCache`, `HybridCache`, or static initialization.
6. **Prioritize by impact and recommend measuring before optimizing.** Rank findings by likely throughput or latency impact. For any finding where the gain is uncertain, require a BenchmarkDotNet micro-benchmark or a profiler trace (dotnet-trace, PerfView, Visual Studio Diagnostic Tools) before investing in the fix. Avoid claiming wins without measurement.

## .NET / Azure checks

- **String allocations in loops.** `string result += item;` inside a loop creates a new `string` object on every iteration — O(n²) allocations. Replace with `StringBuilder` for imperative concatenation, or use interpolated-string handlers (C# 10+) with `StringBuilder.AppendInterpolatedStringHandler` for mixed format strings. In hot serialization paths, write to an `IBufferWriter<byte>` instead of a `string` intermediate.
- **Boxing of value types.** Casting a `struct`, `int`, `Guid`, `DateTime`, or enum to `object` or a non-generic interface (`IComparable`, `IFormattable`) allocates a heap box. Common sources: adding value types to `ArrayList`, passing to `string.Format`'s `object[]` params, using non-generic collections, or calling virtual methods on interfaces through a boxed value. Prefer generic collections and constrained generics.
- **`Span<T>` / `Memory<T>` / `ArrayPool<T>` for buffers.** Methods that slice, parse, or transform byte or char data should operate on `Span<T>` (stack-only) or `Memory<T>` (heap-friendly) rather than allocating sub-arrays. For temporary buffers (e.g., encode/decode scratch space), rent from `ArrayPool<T>.Shared` and return in a `finally` block rather than allocating `new byte[n]` on every call.
- **Needless `.ToList()` / `.ToArray()` materialization.** Calling `.ToList()` only to call `.Count` on the result, or `.ToArray()` to pass to a method that accepts `IEnumerable<T>`, forces full materialization without benefit. Use `.Count()` directly on `IQueryable<T>` to push the count to the database, or accept `IEnumerable<T>` at the call site and avoid materializing until necessary.
- **Multiple enumeration of `IEnumerable<T>`.** Enumerating the same `IEnumerable<T>` more than once (`.Count()` then `foreach`, or two separate `Where` / `Any` calls on a deferred query) executes the underlying query or iterator twice. If the sequence is deferred (a LINQ query, a yield-return, or an EF Core `IQueryable`), materialize it once with `.ToList()` or `.ToArray()` and reuse. For `IQueryable<T>`, prefer projecting the count and results in a single round-trip where the ORM supports it.
- **Sync-over-async: `.Result` / `.Wait()`.** Calling `.Result` or `.Wait()` on a `Task` in an environment with a synchronization context (ASP.NET Core on older hosting, or any code ultimately marshaled back to a captured context) can deadlock. Even where deadlock does not occur, it wastes a thread-pool thread blocking synchronously. Go async all the way: `await task` instead of `task.Result`. Note: `GetAwaiter().GetResult()` carries the same risk. The deadlock is context-dependent — ASP.NET Core's default context does not deadlock the way classic ASP.NET did — but blocking still wastes threads under load.
- **`async void` outside event handlers.** `async void` methods swallow exceptions (they are raised on the thread-pool and crash the process or disappear silently). They also cannot be awaited by callers. Use `async Task` for all async methods except event handlers (`+=` subscriptions) where the delegate signature requires `void`.
- **`IAsyncEnumerable<T>` for streaming results.** Methods that produce large result sets (database cursors, external API pages, file streams) should return `IAsyncEnumerable<T>` and be consumed with `await foreach` rather than buffering into a `List<T>` and returning. This keeps peak memory bounded and reduces time-to-first-byte latency for the caller.
- **`Task.WhenAll` for independent I/O.** Sequential `await call1; await call2; await call3;` where the calls are independent serializes I/O unnecessarily. Use `Task.WhenAll(call1, call2, call3)` (or `Task.WhenAll` over a projected sequence) to fan out and await all completions concurrently. Be aware of the shared `DbContext` constraint: a single `DbContext` is not thread-safe for concurrent operations.
- **`IHttpClientFactory` vs `new HttpClient()` per call.** Constructing `new HttpClient()` per request (or per method call) exhausts socket connections — the underlying `SocketsHttpHandler` is not reused, so old connections linger in `TIME_WAIT`. Register typed or named clients via `builder.Services.AddHttpClient<TClient, TImpl>()` and inject `IHttpClientFactory` or the typed client; the factory manages handler lifetime and connection pooling.
- **`IMemoryCache` / `HybridCache` for expensive repeated work.** Repeated calls to external APIs, database lookups, or CPU-heavy computations that return the same result within a time window should be cached. Use `IMemoryCache` (in-process) or `HybridCache` (.NET 9+, two-tier with distributed backing) rather than a `static Dictionary` or per-request recalculation. For high-concurrency scenarios, use `GetOrCreateAsync` with a factory to avoid cache-stampede (multiple threads computing the same value simultaneously).
- **Reuse `JsonSerializerOptions` and use System.Text.Json source generation.** `new JsonSerializerOptions { ... }` on every serialize/deserialize call causes reflection-based metadata to be compiled on each construction — this is both slow and allocation-heavy. Create a single `static readonly JsonSerializerOptions` instance (or register it via `AddJsonOptions` in ASP.NET Core). For maximum throughput in hot paths, use System.Text.Json source generation (`[JsonSerializable]` + `JsonSerializerContext`) to eliminate runtime reflection entirely.

## Red flags

| Signal | Why it matters |
|--------|----------------|
| `.Result` or `.Wait()` in a request handler or service | Blocks a thread-pool thread synchronously; can deadlock in contexts with a synchronization context; wastes throughput under load. Go async all the way. |
| `new HttpClient()` constructed per request or per method call | No connection pooling — each instance opens new TCP connections that linger in `TIME_WAIT`, exhausting ephemeral ports under moderate traffic. Use `IHttpClientFactory`. |
| `string result += item` inside a loop | Allocates a new `string` on every concatenation — O(n²) total allocation. Use `StringBuilder` or interpolated-string handlers. |
| `IEnumerable<T>` enumerated more than once (e.g., `.Count()` then `foreach`) | Executes the underlying query or iterator twice; for EF Core `IQueryable<T>` this means two round-trips to the database. Materialize once. |
| `new JsonSerializerOptions(...)` inside a method | Triggers reflection-based metadata compilation on every call. Use a `static readonly` instance or ASP.NET Core's registered options. |
| `async void` on a method that is not a UI/event handler | Exceptions are unobserved and crash or silently disappear; the method cannot be awaited. Return `Task` instead. |
| `.ToList()` called only to use `.Count` on the result | Materializes the full sequence needlessly. Call `.Count()` on `IQueryable<T>` (pushes to the DB) or `.Any()` when only presence is needed. |
| `new byte[size]` allocated on every call for a scratch buffer | Creates GC pressure proportional to request rate. Rent from `ArrayPool<T>.Shared` and return in `finally`. |
| Sequential `await` of independent I/O calls | Serializes work that could run in parallel. Replace with `await Task.WhenAll(...)` for independent tasks. |
| Missing `IMemoryCache` / `HybridCache` for a known hot lookup | Every request recomputes or re-fetches data that does not change per call. Cache with a TTL and a stampede guard. |

## Example

See [`examples/dotnet-performance-review/`](../../examples/dotnet-performance-review/).

## Related skills

- [ef-core-review](../ef-core-review/SKILL.md) — use for deep EF Core query performance (N+1, tracking, projections).
- [resilience-review](../resilience-review/SKILL.md) — use to review timeouts and retry policies on downstream calls that affect throughput.
