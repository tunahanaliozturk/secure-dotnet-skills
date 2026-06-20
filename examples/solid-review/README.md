# Example: solid-review

A worked review of a god `OrderService` that violates SRP, OCP, and DIP in concrete ways — followed by a refactor that splits responsibilities into focused, injected collaborators.

---

## BEFORE — god OrderService

```csharp
// OrderService.cs
public class OrderService
{
    private readonly AppDbContext _db;

    public OrderService(AppDbContext db)
    {
        _db = db;
    }

    public async Task<OrderResult> PlaceOrderAsync(OrderRequest request)
    {
        // (a) Validation — business rule lives in the same class as I/O
        if (request.Items == null || !request.Items.Any())
            throw new ArgumentException("Order must have at least one item.");
        if (request.CustomerId == Guid.Empty)
            throw new ArgumentException("CustomerId is required.");

        // (b) Tax calculation — constructs its own HttpClient (no pooling, no mock)
        decimal taxRate;
        using (var client = new HttpClient())  // DIP violation: hidden concrete dependency
        {
            var response = await client.GetStringAsync(
                $"https://tax-api.example.com/rate?country={request.Country}");
            taxRate = decimal.Parse(response);
        }

        // (c) Persistence via EF Core
        var order = new Order
        {
            CustomerId = request.CustomerId,
            Items      = request.Items,
            TaxRate    = taxRate,
            PlacedAt   = DateTime.Now,  // DIP violation: hidden dependency on system clock
        };
        _db.Orders.Add(order);
        await _db.SaveChangesAsync();

        // (d) Confirmation email — another side-effect baked into the same class
        using (var smtp = new System.Net.Mail.SmtpClient("smtp.example.com"))
        {
            var mail = new System.Net.Mail.MailMessage(
                "orders@example.com",
                request.CustomerEmail,
                "Your order has been placed",
                $"Order {order.Id} confirmed. Tax rate: {taxRate:P}");
            smtp.Send(mail);
        }

        return new OrderResult(order.Id, order.PlacedAt);
    }
}
```

---

## Findings

| # | Smell | Violated principle | Why it matters |
|---|-------|--------------------|----------------|
| 1 | Validation, persistence, tax fetch, and email all live in one class | **SRP** | Four distinct reasons to change: business rules, storage schema, tax provider, email provider. Any of these forces a change to the same file. |
| 2 | `new HttpClient()` constructed inline | **DIP** | Bypasses `IHttpClientFactory` connection pooling (socket exhaustion under load), hides the dependency, and makes the class untestable without hitting the real tax API. |
| 3 | `new System.Net.Mail.SmtpClient(...)` constructed inline | **DIP** | Same problem as `HttpClient`: hidden I/O dependency, untestable without a real mail server. |
| 4 | `DateTime.Now` read directly inside the method | **DIP** | Non-deterministic under tests; `PlacedAt` will differ on every run, making assertions fragile without time-travel hacks. |

> **Judgment note:** `new OrderResult(order.Id, order.PlacedAt)` is fine — it's a plain data bag with no behavior, no I/O, and no reason you'd ever want to swap it for a test double. DIP matters when the constructed object has behavior, external I/O, or configuration.

---

## AFTER — thin coordinator with injected collaborators

### Interfaces (role contracts)

```csharp
// IOrderValidator.cs  — SRP: owns validation rules only
public interface IOrderValidator
{
    void Validate(OrderRequest request); // throws ArgumentException on failure
}

// ITaxClient.cs  — DIP: abstraction over the external tax API
public interface ITaxClient
{
    Task<decimal> GetRateAsync(string country, CancellationToken ct = default);
}

// IOrderNotifier.cs  — SRP: owns notification dispatch only
public interface IOrderNotifier
{
    Task SendConfirmationAsync(Order order, string customerEmail, CancellationToken ct = default);
}
```

### Focused collaborators

```csharp
// OrderValidator.cs
public sealed class OrderValidator : IOrderValidator
{
    public void Validate(OrderRequest request)
    {
        if (request.Items == null || !request.Items.Any())
            throw new ArgumentException("Order must have at least one item.");
        if (request.CustomerId == Guid.Empty)
            throw new ArgumentException("CustomerId is required.");
    }
}

// TaxClient.cs  — typed client; IHttpClientFactory handles pooling and lifetime
public sealed class TaxClient : ITaxClient
{
    private readonly HttpClient _http;

    public TaxClient(HttpClient http) => _http = http;  // injected by IHttpClientFactory

    public async Task<decimal> GetRateAsync(string country, CancellationToken ct = default)
    {
        var response = await _http.GetStringAsync(
            $"rate?country={Uri.EscapeDataString(country)}", ct);
        return decimal.Parse(response);
    }
}

// OrderNotifier.cs  — depends on IEmailSender abstraction, not SmtpClient directly
public sealed class OrderNotifier : IOrderNotifier
{
    private readonly IEmailSender _email;

    public OrderNotifier(IEmailSender email) => _email = email;

    public Task SendConfirmationAsync(Order order, string customerEmail, CancellationToken ct = default)
        => _email.SendAsync(
            to:      customerEmail,
            subject: "Your order has been placed",
            body:    $"Order {order.Id} confirmed. Tax rate: {order.TaxRate:P}",
            ct:      ct);
}
```

### Refactored OrderService — thin coordinator

```csharp
// OrderService.cs
public sealed class OrderService
{
    private readonly IOrderValidator _validator;
    private readonly AppDbContext    _db;
    private readonly ITaxClient      _taxClient;
    private readonly IOrderNotifier  _notifier;
    private readonly TimeProvider    _time;       // .NET 8+ — injected, deterministic

    public OrderService(
        IOrderValidator validator,
        AppDbContext    db,
        ITaxClient      taxClient,
        IOrderNotifier  notifier,
        TimeProvider    time)
    {
        _validator = validator;
        _db        = db;
        _taxClient = taxClient;
        _notifier  = notifier;
        _time      = time;
    }

    public async Task<OrderResult> PlaceOrderAsync(
        OrderRequest    request,
        CancellationToken ct = default)
    {
        // SRP: delegate validation — OrderService no longer owns the rules
        _validator.Validate(request);

        // DIP: tax rate via injected ITaxClient (IHttpClientFactory under the hood)
        var taxRate = await _taxClient.GetRateAsync(request.Country, ct);

        var order = new Order
        {
            CustomerId = request.CustomerId,
            Items      = request.Items,
            TaxRate    = taxRate,
            PlacedAt   = _time.GetUtcNow().UtcDateTime,  // DIP: no more DateTime.Now
        };

        _db.Orders.Add(order);
        await _db.SaveChangesAsync(ct);

        // SRP: delegate notification — OrderService no longer owns email logic
        await _notifier.SendConfirmationAsync(order, request.CustomerEmail, ct);

        return new OrderResult(order.Id, order.PlacedAt);
    }
}
```

### DI registration (Program.cs / Startup)

```csharp
builder.Services.AddScoped<IOrderValidator, OrderValidator>();
builder.Services.AddScoped<IOrderNotifier, OrderNotifier>();
builder.Services.AddScoped<IEmailSender, SmtpEmailSender>();  // swap for SendGrid, etc.
builder.Services.AddScoped<OrderService>();

// Typed client — IHttpClientFactory manages pooling and lifetime
builder.Services.AddHttpClient<ITaxClient, TaxClient>(client =>
    client.BaseAddress = new Uri("https://tax-api.example.com/"));

// TimeProvider — use FakeTimeProvider in tests (Microsoft.Extensions.TimeProvider.Testing)
builder.Services.AddSingleton(TimeProvider.System);
```

---

## Why each refactor works

**SRP — Extract `IOrderValidator`:**
Validation rules change independently of persistence and notification. Extracting them to `OrderValidator` means a new business rule (e.g., minimum order value) touches one file with one reason to change.

**SRP — Extract `IOrderNotifier`:**
Switching from SMTP to SendGrid, or adding an SMS fallback, no longer requires touching `OrderService`. The notifier owns that decision entirely.

**DIP — `ITaxClient` via `IHttpClientFactory`:**
`new HttpClient()` is replaced by a typed client registered with `AddHttpClient<ITaxClient, TaxClient>()`. The DI container manages the underlying `HttpClientHandler` lifecycle, preventing socket exhaustion. In tests, inject a mock `ITaxClient` — no network required.

**DIP — `TimeProvider` instead of `DateTime.Now`:**
`_time.GetUtcNow()` is deterministic under test when you inject `FakeTimeProvider` from `Microsoft.Extensions.TimeProvider.Testing`. The production registration `TimeProvider.System` preserves real-world behavior with zero overhead.
