---
name: solid-review
description: Use when reviewing C# / .NET code for SOLID design adherence — single responsibility, open/closed, Liskov, interface segregation, dependency inversion — to surface coupling and concrete refactor opportunities.
---

# SOLID Design Review

Directs the agent to walk a C# class or module through each SOLID principle using concrete .NET lenses, naming the smell, the violated principle, and the minimal refactor — prioritizing violations that cause real coupling or churn, not textbook nits.

## When to use

- A class is growing unwieldy — it spans IO, business logic, mapping, and side-effects in one file.
- A PR introduces a new type variant and an existing `switch` or `if-else` chain must be edited to accommodate it.
- Constructors `new` up their own dependencies or reference `DateTime.Now` / `static` helpers directly.
- An interface has accumulated members to satisfy multiple unrelated callers, forcing no-op implementations.

## Process

1. **Identify the class/module under review.** Name its stated responsibility. If the name requires "and" or "or" to describe it, that is already a signal.
2. **Walk each SOLID principle in order** using the C# lenses below. Treat each as a separate pass; do not stop after the first finding.
3. **Name the smell and the violated principle.** "Fat constructor assembling its own `HttpClient` and `SqlConnection`" → DIP; "base override throwing `NotSupportedException`" → LSP. Be precise.
4. **Propose the minimal refactor with the C# mechanism.** Name the type, pattern, or DI registration change — not just "apply the principle." Generic "follow SOLID" advice is not a finding.
5. **Prioritize by actual impact.** A god service that mixes EF persistence with email dispatch causes churn every sprint; an `IOrderService` with 12 members that no caller uses fully is a genuine ISP violation. A `sealed` class that happens to satisfy two loosely related use cases is not SRP-breaking if it has one reason to change. Distinguish violations that hurt from those that are merely impure.

## .NET / Azure checks

### SRP — Single Responsibility Principle

- **God services / god classes.** A single class that touches EF Core (`_context.SaveChangesAsync`), sends email (`_emailSender.SendAsync`), validates business rules, and maps to DTOs has multiple reasons to change. Extract an `IOrderValidator`, an `IOrderRepository` (or use the DbContext directly in a dedicated persistence class), and an `IOrderNotifier` as separate collaborators.
- **Fat controllers.** An ASP.NET Core controller that contains `if`/validation logic, calls the database directly, and formats response payloads is doing three jobs. Controllers should orchestrate: call a service, map the result, return `IActionResult`. Business rules belong in the application/domain layer.
- **"And" in the type name or responsibility.** `OrderValidationAndPersistenceService` is a naming smell that signals SRP violation. If you can only describe the class using "and," split it.
- **Multiple reasons to change.** Ask: "Would this class need to change if we switched email providers? If we changed the database schema? If business rules changed?" More than one "yes" means more than one responsibility.

### OCP — Open/Closed Principle

- **Growing `switch` / `if-else` on a type discriminator.** A `switch(order.Type)` block inside a service that must be reopened for every new `OrderType` enum value violates OCP. Replace with a strategy: define `IOrderHandler` (or `IOrderProcessor`) and register one implementation per type; resolve via `IEnumerable<IOrderHandler>` injected into the coordinator, dispatching on `handler.Handles(order.Type)`.
- **Hard-coded behavior expansion.** If adding a new discount rule, notification channel, or export format requires editing an existing class, rather than dropping in a new `IDiscountRule` or `IExporter`, the class is not closed for modification. Introduce the abstraction before the second case lands.
- **Type-discriminator anti-pattern.** `if (order is PremiumOrder)` or `if (typeof(T) == typeof(FooOrder))` inside a processing class is a code smell equivalent to the `switch` above. Polymorphism or a strategy registry eliminates these.

### LSP — Liskov Substitution Principle

- **Overrides that `throw new NotSupportedException()` / `NotImplementedException()`.** A subtype that cannot honor a base contract (e.g., `ReadOnlyCollection<T>` throwing on `Add`) violates LSP. If the override cannot be implemented meaningfully, the hierarchy is wrong — prefer composition or separate interfaces.
- **Subtypes weakening postconditions.** If the base class guarantees `GetOrders()` never returns `null`, an override returning `null` violates the contract callers rely on. Document invariants (XML doc or contracts) and enforce them in overrides.
- **Subtypes strengthening preconditions.** An override that adds a null-check not present in the base, or that rejects a valid parameter range the base accepted, breaks code that passes valid base-contract input. The subtype must accept anything the base accepted.
- **Pervasive `is`/`as` downcasts in calling code.** `if (handler is SpecialHandler sh) sh.SpecialMethod()` in the caller means the abstraction is broken — either the method belongs on the base interface, or the types should not share a hierarchy. Frequent downcasts are a LSP / abstraction failure signal.

### ISP — Interface Segregation Principle

- **Fat interfaces (10+ members) with unrelated concerns.** An `IOrderService` exposing `CreateOrder`, `CancelOrder`, `GetInvoice`, `SendConfirmation`, `ExportToCsv`, `CalculateTax`, `ValidateAddress`, and `GetShippingRates` forces every implementor and test double to stub methods it does not use. Split into role interfaces: `IOrderWriter`, `IOrderReader`, `IOrderNotifier`, `IOrderExporter`.
- **No-op implementations / `NotImplementedException` stubs.** If a mock or test implementation returns `throw new NotImplementedException()` for half the interface members, those members belong to a different role interface. The presence of no-ops is direct evidence of ISP violation.
- **Clients importing methods they never call.** If `PaymentService` depends on `IOrderService` but only calls `GetOrder`, it should depend on `IOrderReader`. Narrowing the dependency makes coupling explicit and testing cheaper.

### DIP — Dependency Inversion Principle

- **`new`-ing concrete dependencies inside a class.** `new HttpClient()` constructed inside a service creates a hidden dependency, bypasses the DI container, leaks sockets (no connection pooling), and makes the class untestable without reflection tricks. Inject `IHttpClientFactory` (typed client) or a named client via the constructor. Same pattern for `new SqlConnection(connectionString)` — inject `IDbConnectionFactory` or let EF Core / Dapper manage the connection via the registered `DbContext`.
- **Depending on concretes rather than abstractions.** A constructor typed to `SqlOrderRepository` rather than `IOrderRepository` couples the class to the storage technology. Any class that should be reusable or testable in isolation must depend only on interfaces or abstract types.
- **Hidden coupling to `DateTime.Now` / static state.** `var now = DateTime.Now` inside a business method makes the class non-deterministic and untestable without time-travel hacks. Introduce `ISystemClock` (or use `TimeProvider` from .NET 8+) and inject it. The same applies to `Environment.MachineName`, `Random.Shared`, or any other ambient static.
- **Static mutable singletons.** A `static Dictionary<string, Order> _cache` in a service class is hidden shared state that bypasses DI lifetime management and is not safe for concurrent use. Replace with `IMemoryCache` / `IDistributedCache` injected via DI, which supports proper scoping and eviction.

> **Judgment note:** not every `new` is a DIP violation. `new OrderDto(order)` (a plain data bag) or `new List<T>()` (a standard collection) are fine. DIP matters when the constructed object has behavior, external I/O, or configuration — i.e., when swapping it for a test double or alternative implementation would be valuable.

## Red flags

| Signal | Why it matters |
|--------|----------------|
| `new HttpClient()` constructed inside a service method or constructor | Bypasses `IHttpClientFactory` connection pooling (socket exhaustion under load), hides the dependency, and makes the class untestable without production I/O. |
| `switch(order.Type)` or `if (x is ConcreteType)` in a coordinator class | Must be reopened for every new variant; callers know too much about the type hierarchy. Replace with `IEnumerable<IHandler>` resolved from DI. |
| `throw new NotImplementedException()` or `throw new NotSupportedException()` in a non-abstract override | The subtype cannot honor the base contract — LSP violation. Either implement the method correctly or restructure the hierarchy. |
| An interface with 10+ members where callers use 2–3 of them | Forces large test doubles; signals that multiple role interfaces have been collapsed into one. |
| A class constructing its own `DbContext` via `new AppDbContext(options)` | Bypasses DI lifetime management (`Scoped` vs `Transient` vs `Singleton`), prevents connection pooling, and breaks testability. Inject `AppDbContext` or `IDbContextFactory<AppDbContext>`. |
| `DateTime.Now` called directly inside a business method | Non-deterministic under tests; coupling to the system clock hides a logical dependency. Inject `TimeProvider` (.NET 8+) or `ISystemClock`. |
| A controller action containing `if`/`switch` business logic or EF queries | The controller has taken on responsibilities that belong in the application/domain layer; single change to business rules requires touching the controller. |
| `static` mutable field used as an in-process cache | Thread-unsafe without explicit locking; bypasses DI scoping; cannot be evicted or observed. Use `IMemoryCache`. |

## Example

See [`examples/solid-review/`](../../examples/solid-review/).
