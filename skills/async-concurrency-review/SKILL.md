---
name: async-concurrency-review
description: Use when reviewing asynchronous and concurrent .NET code — async/await correctness, deadlocks, cancellation propagation, and thread safety of shared state.
---

# Async / Concurrency Review

Directs the agent to walk .NET / ASP.NET Core async and concurrent code through concrete correctness lenses — sync-over-async deadlock risk, cancellation propagation, shared-state safety, fire-and-forget hazards, and parallel-execution patterns — surfacing defects with precise fixes.

## When to use

- A PR adds or modifies `async`/`await` code, background work, or concurrent operations in a .NET service.
- Code uses `Task.WhenAll`, `Parallel.ForEachAsync`, or any form of parallelism over shared resources.
- A service is deadlocking, hanging under load, or losing exceptions silently.
- A `DbContext`, `static` field, or other non-thread-safe resource is accessed from multiple threads or concurrent tasks.

## Process

1. **Map the async call chains and shared mutable state.** Trace each `async` method from its entry point (controller action, `IHostedService`, message handler) to its leaves. Note any non-`async` call sites that block on `Task` results, any shared objects accessed across concurrent paths, and any fire-and-forget launches.
2. **Check for sync-over-async and deadlock risk.** Find every `.Result`, `.Wait()`, and `GetAwaiter().GetResult()` call. For each, determine whether a synchronization context is present (classic ASP.NET, WinForms, WPF, MAUI all have one; ASP.NET Core does not by default). Even where deadlock is not imminent, blocking wastes a thread-pool thread for the full I/O duration — identify and convert to `await`.
3. **Check cancellation propagation.** Confirm that every method doing I/O (EF Core queries, `HttpClient` calls, file I/O, `Task.Delay`) accepts a `CancellationToken` parameter, passes it downstream, and — where the work is a loop — checks `ct.ThrowIfCancellationRequested()` (or equivalent) at each iteration boundary.
4. **Check thread safety of shared state.** For each object that could be reached from two concurrent tasks or threads, verify it is thread-safe. Flag `DbContext` instances captured across `Task.WhenAll` branches (throws `InvalidOperationException: "A second operation was started on this context before a previous operation completed"`), `static` mutable fields, and unsynchronized shared collections. Where a `lock` is present, verify it does not span an `await` — that is a compile error in C# but the intention (mutual exclusion around async work) must be redirected to `SemaphoreSlim`.
5. **Check fire-and-forget patterns.** Find `_ = DoAsync()`, unawited method calls, and `Task.Run(() => ...)` whose result is discarded. Determine how exceptions are observed. A fire-and-forget task whose exception is never observed will be silently swallowed (.NET 4.5+); the work may also outlive the request or host shutdown. Replace with a safe background pattern: channel + `IHostedService` consumer, or `IBackgroundTaskQueue`.
6. **Recommend fixes with correct .NET APIs.** For each finding, name the concrete replacement: `await` over `.Result`; `SemaphoreSlim.WaitAsync` over `lock`+`await`; `IDbContextFactory<TContext>` for per-operation scoped contexts; `Channel<T>` or `IHostedService` for safe background work; `Parallel.ForEachAsync` with a `ParallelOptions.MaxDegreeOfParallelism` for throttled parallel I/O.

## .NET / Azure checks

- **Sync-over-async: `.Result` / `.Wait()` / `GetAwaiter().GetResult()`.** All three block the calling thread until the `Task` completes. In environments with a `SynchronizationContext` — classic ASP.NET, WinForms, WPF — this causes a deadlock: `await` captures the context and tries to resume on it, but `.Result`/`.Wait()` is holding the context's single permitted thread, so the continuation can never run. ASP.NET Core does not install a single-threaded `SynchronizationContext`, so the classic deadlock does not occur there; however, blocking still wastes a thread-pool thread for the full I/O duration, reducing throughput under load. The fix in all environments is to go `async` all the way to the entry point.

- **`async void` outside event handlers.** `async void` methods are only legitimate for event handlers (`Button.Click +=`, `ICommand.Execute` implementations) where the delegate signature requires `void`. For all other methods, `async void` has two defects: (1) exceptions thrown after the first `await` are raised on the thread-pool synchronization context and are unobserved — in .NET 6+ they crash the process via `UnhandledException`; (2) callers cannot `await` the method, so they have no way to know when it completes or whether it succeeded. Replace with `async Task`.

- **`ConfigureAwait(false)` in library code.** In a library (a NuGet package or shared class library consumed by multiple app types), `await someTask` without `.ConfigureAwait(false)` captures the caller's `SynchronizationContext` and resumes on it. In a classic ASP.NET or UI host, this can cause deadlock when combined with `.Result` upstream, and always incurs a context-switch overhead. Call `.ConfigureAwait(false)` on every `await` in library code that does not need to resume on the original context. In ASP.NET Core application code (controllers, Razor pages, minimal API handlers), `.ConfigureAwait(false)` is not required because ASP.NET Core does not install a blocking single-threaded context — omitting it is fine and reduces noise.

- **`CancellationToken` accepted and propagated through the chain.** Every method that performs I/O — `DbContext` queries, `HttpClient` calls, `Task.Delay`, file reads — must accept a `CancellationToken` parameter and pass it to every downstream async call. A token that is accepted but not passed to `ToListAsync(ct)`, `SendAsync(request, ct)`, or `Task.Delay(ms, ct)` provides no cancellation benefit and misleads callers. For long-running loops, call `ct.ThrowIfCancellationRequested()` at the top of each iteration, or use `ct.IsCancellationRequested` with a graceful break, so that cancellation is honored promptly rather than only between I/O calls.

- **Fire-and-forget swallowing exceptions.** A discarded `Task` (`_ = DoAsync()`, an un-awaited call, or `Task.Run(...)` whose result is not stored and awaited) means any exception thrown after the first `await` is silently lost — it is placed on the task and never observed. The work also continues past request completion, past `IApplicationLifetime.ApplicationStopping`, and past host shutdown. The safe pattern is a `Channel<T>` (unbounded or bounded) written to by the request handler and drained by a `BackgroundService` (`IHostedService`) consumer that observes exceptions and respects `CancellationToken` on shutdown.

- **Shared mutable state without synchronization.** Objects accessed from multiple concurrent tasks without synchronization produce data races. `Dictionary<TKey,TValue>` is not thread-safe — concurrent reads during a write can corrupt its internal state; use `ConcurrentDictionary<TKey,TValue>`. `static` mutable fields (counters, caches, configuration that mutates) must be protected with `Interlocked`, `lock`, or a thread-safe type. Non-thread-safe state machines or domain objects must be confined to a single task at a time.

- **`DbContext` not thread-safe across `Task.WhenAll`.** `DbContext` is explicitly documented as not thread-safe; concurrent operations on the same instance throw `InvalidOperationException: "A second operation was started on this context instance before a previous operation completed. This is usually caused by different threads concurrently using the same instance of DbContext."` A common mistake is capturing a single injected `DbContext` in a closure and then fanning it out across `Task.WhenAll`. The correct pattern is `IDbContextFactory<TContext>` (registered via `AddDbContextFactory<TContext>`): call `await factory.CreateDbContextAsync(ct)` inside each parallel branch, `await` its work, and dispose it — each branch owns a fully independent context and connection.

- **`lock` cannot wrap `await`.** C# prohibits `await` inside a `lock` block at the compiler level (`CS1996`). The intent — mutual exclusion around an async critical section — must be fulfilled by `SemaphoreSlim` instead: `await semaphore.WaitAsync(ct)` before the critical section and `semaphore.Release()` in a `finally` block after it. `SemaphoreSlim` initialized to `(1, 1)` provides the same mutual-exclusion semantics as `lock` for async code.

- **`Task.WhenAll` / `Parallel.ForEachAsync` with throttling.** Unbounded parallelism — `Task.WhenAll` over a large sequence without a concurrency cap — can exhaust the thread pool, open too many database connections, or overwhelm a downstream service. Use `Parallel.ForEachAsync` (introduced in .NET 6) with `ParallelOptions { MaxDegreeOfParallelism = N, CancellationToken = ct }` to process a sequence with bounded concurrency. For a batch of known tasks, use `SemaphoreSlim` as a gate: acquire before launching each task, release inside the task body. Always pair parallelism with a `CancellationToken` so the fan-out can be aborted on shutdown or timeout.

## Red flags

| Signal | Why it matters |
|--------|----------------|
| `.Result`, `.Wait()`, or `GetAwaiter().GetResult()` in a request handler or service method | Blocks a thread-pool thread for the full I/O duration; deadlocks in any host with a single-threaded `SynchronizationContext` (classic ASP.NET, WinForms, WPF). Go async all the way. |
| `async void` on a method that is not an event handler | Exceptions after the first `await` are unobserved and crash the process (`UnhandledException`) or silently disappear. Callers cannot `await` it. Return `async Task`. |
| `lock` block containing an `await` expression | Does not compile (`CS1996`); the intent (async mutual exclusion) requires `SemaphoreSlim.WaitAsync` + `Release` in `finally` instead. |
| A single `DbContext` instance captured across `Task.WhenAll` branches | Concurrent operations on `DbContext` throw `InvalidOperationException: "A second operation was started…"`. Use `IDbContextFactory<TContext>` to create one context per parallel branch. |
| `_ = DoAsync()` or an un-awaited `Task`-returning call | Exceptions are silently swallowed; the work outlives the request and ignores host-shutdown signals. Replace with a `Channel<T>` + `IHostedService` consumer. |
| A method performing I/O with no `CancellationToken` parameter | Cancellation signals from the HTTP request or host shutdown are not honored — the operation runs to completion even after the caller has given up, wasting resources. Accept and propagate `CancellationToken`. |
| `static` mutable field written from multiple tasks or threads | Data races on non-atomic types corrupt state silently. Protect with `Interlocked`, `lock`, or replace with `ConcurrentDictionary` / `IMemoryCache`. |
| `Task.WhenAll` over an unbounded sequence without a concurrency cap | Can open hundreds of database connections or HTTP connections simultaneously, overwhelming the downstream resource. Use `Parallel.ForEachAsync` with `MaxDegreeOfParallelism` or a `SemaphoreSlim` gate. |
| `CancellationToken` accepted by a method but not forwarded to `ToListAsync`, `SendAsync`, or `Task.Delay` | The token is accepted but ignored — cancellation has no effect on the I/O. Pass the token to every async call in the chain. |
| `ConfigureAwait(false)` absent in a shared library that also has `.Result` callers upstream | The missing `.ConfigureAwait(false)` captures the caller's `SynchronizationContext`; combined with a `.Result` upstream, this creates a deadlock in classic ASP.NET or UI hosts. |

## Example

See [`examples/async-concurrency-review/`](../../examples/async-concurrency-review/).
