# Example: api-contract-review

A `POST /orders` endpoint that starts with several common contract violations and is then corrected to use proper HTTP semantics.

---

## Before — contract violations

The original endpoint returns `200 OK` with an ad-hoc error body on bad input, returns `200 OK` (not `201 Created`) even on success, omits the `Location` header, and has no idempotency support.

```csharp
// OrdersController.cs  — BEFORE (violations highlighted in comments)
[ApiController]
[Route("orders")]
public class OrdersController : ControllerBase
{
    private readonly AppDbContext _db;
    public OrdersController(AppDbContext db) => _db = db;

    // VIOLATION 1: No [ProducesResponseType] declarations — OpenAPI is blind to error shapes.
    // VIOLATION 2: Accepts and returns the EF entity directly (exposes RowVersion, navigation props).
    [HttpPost]
    public async Task<IActionResult> Create([FromBody] Order order)
    {
        if (order.Quantity <= 0)
        {
            // VIOLATION 3: 200 OK with an ad-hoc error body — HTTP status is wrong; no RFC 7807.
            return Ok(new { error = "invalid", field = "quantity" });
        }

        _db.Orders.Add(order);
        await _db.SaveChangesAsync();

        // VIOLATION 4: 200 OK on create — should be 201 Created + Location header.
        // VIOLATION 5: No Idempotency-Key — a network retry causes a duplicate order.
        return Ok(order);
    }
}
```

Problems:

| # | Violation | Impact |
|---|-----------|--------|
| 1 | No `[ProducesResponseType]` declarations | OpenAPI generator emits no schema for error or success responses; SDK authors are blind. |
| 2 | EF `Order` entity as input and output DTO | Exposes `RowVersion`, navigation properties; couples wire contract to DB schema; overposting risk. |
| 3 | `200 OK` + `{ "error": "invalid" }` on validation failure | Clients cannot distinguish success from failure by status code; not RFC 7807. |
| 4 | `200 OK` on create, no `Location` header | Violates RFC 7231 §6.3.2; client cannot locate the new resource without parsing the body. |
| 5 | No `Idempotency-Key` handling | A transient error during the POST causes a retry that creates a duplicate order. |

---

## After — correct contract

The corrected version uses:

- A dedicated request DTO and response DTO (never the EF entity).
- `422 Unprocessable Entity` + `ValidationProblemDetails` (RFC 7807) on invalid input.
- `201 Created` + `Location` header on success.
- `Idempotency-Key` deduplication so safe retries are possible.
- Full `[ProducesResponseType]` annotations so the OpenAPI document is accurate.

```csharp
// ---- DTOs -----------------------------------------------------------------

public sealed record CreateOrderRequest(
    [Required] string ProductId,
    [Range(1, 1000)] int Quantity,
    [Required] string ShippingAddress);

public sealed record CreateOrderResponse(
    Guid Id,
    string ProductId,
    int Quantity,
    string ShippingAddress,
    DateTimeOffset CreatedAt);

// ---- Controller -----------------------------------------------------------

[ApiController]
[Route("v{version:apiVersion}/orders")]
[ApiVersion("1.0")]
public class OrdersController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly IIdempotencyStore _idempotency;   // e.g. backed by IDistributedCache / Redis

    public OrdersController(AppDbContext db, IIdempotencyStore idempotency)
    {
        _db = db;
        _idempotency = idempotency;
    }

    /// <summary>Create a new order.</summary>
    [HttpPost]
    [ProducesResponseType<CreateOrderResponse>(StatusCodes.Status201Created)]
    [ProducesResponseType<ValidationProblemDetails>(StatusCodes.Status422UnprocessableEntity)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
    public async Task<IActionResult> Create(
        [FromHeader(Name = "Idempotency-Key")] string? idempotencyKey,
        [FromBody] CreateOrderRequest request,
        CancellationToken ct)
    {
        // Step 1: Model validation — ASP.NET Core runs [Required] / [Range] automatically.
        // If ModelState is invalid, return 422 + ValidationProblemDetails (RFC 7807).
        // Note: [ApiController] automatic 400 is suppressed via SuppressModelStateInvalidFilter = true
        // (see Program.cs); this explicit check is what actually returns 422.
        if (!ModelState.IsValid)
            return ValidationProblem(statusCode: StatusCodes.Status422UnprocessableEntity); // 422 Unprocessable Entity
                                                    // Content-Type: application/problem+json
                                                    // Body: ValidationProblemDetails { errors: { "Quantity": ["..."] } }

        // Step 2: Idempotency check — replay the stored response if the key was seen before.
        if (idempotencyKey is not null)
        {
            var cached = await _idempotency.GetAsync(idempotencyKey, ct);
            if (cached is not null)
                return cached.ToActionResult();     // Return the original 201 + Location unchanged.
        }

        // Step 3: Business-level conflict check (duplicate prevention beyond idempotency).
        var exists = await _db.Orders
            .AnyAsync(o => o.ProductId == request.ProductId
                        && o.ShippingAddress == request.ShippingAddress
                        && o.CreatedAt > DateTimeOffset.UtcNow.AddSeconds(-30), ct);
        if (exists)
            return Problem(
                detail: "A duplicate order was detected within the last 30 seconds.",
                statusCode: StatusCodes.Status409Conflict);     // 409 Conflict — ProblemDetails

        // Step 4: Persist.
        var order = new Order
        {
            Id = Guid.NewGuid(),
            ProductId = request.ProductId,
            Quantity = request.Quantity,
            ShippingAddress = request.ShippingAddress,
            CreatedAt = DateTimeOffset.UtcNow,
        };
        _db.Orders.Add(order);
        await _db.SaveChangesAsync(ct);

        // Step 5: Build the response DTO (never return the EF entity).
        var response = new CreateOrderResponse(
            order.Id, order.ProductId, order.Quantity, order.ShippingAddress, order.CreatedAt);

        // Step 6: Cache the response for idempotency replay.
        if (idempotencyKey is not null)
            await _idempotency.StoreAsync(idempotencyKey, response, ct);

        // Step 7: 201 Created + Location header.
        return CreatedAtAction(
            nameof(GetById),                                    // resolves to /v1/orders/{id}
            new { version = "1.0", id = order.Id },
            response);
    }

    [HttpGet("{id:guid}")]
    [ProducesResponseType<CreateOrderResponse>(StatusCodes.Status200OK)]
    [ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> GetById(Guid id, CancellationToken ct)
    {
        var order = await _db.Orders.FindAsync(new object[] { id }, ct);
        if (order is null)
            return NotFound();      // 404 — ProblemDetails via AddProblemDetails()

        return Ok(new CreateOrderResponse(
            order.Id, order.ProductId, order.Quantity, order.ShippingAddress, order.CreatedAt));
    }
}
```

### Program.cs wiring

```csharp
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers();

// Suppress [ApiController]'s automatic 400 response so the controller's explicit
// ValidationProblem(statusCode: 422) call is reached and actually returns 422.
builder.Services.Configure<ApiBehaviorOptions>(o => o.SuppressModelStateInvalidFilter = true);

// RFC 7807 ProblemDetails for unhandled errors (404, 405, 500, etc.)
builder.Services.AddProblemDetails();

// OpenAPI document generation
builder.Services.AddOpenApi();

// API versioning — URL segment strategy
builder.Services
    .AddApiVersioning(opts =>
    {
        opts.DefaultApiVersion = new ApiVersion(1, 0);
        opts.AssumeDefaultVersionWhenUnspecified = true;
        opts.ReportApiVersions = true;
    })
    .AddApiExplorer(opts =>
    {
        opts.GroupNameFormat = "'v'VVV";
        opts.SubstituteApiVersionInUrl = true;
    });

// Idempotency store backed by the distributed cache
builder.Services.AddDistributedMemoryCache();
builder.Services.AddSingleton<IIdempotencyStore, DistributedCacheIdempotencyStore>();

var app = builder.Build();

app.UseExceptionHandler();  // returns ProblemDetails for unhandled exceptions
app.MapOpenApi();           // /openapi/v1.json
app.MapControllers();
app.Run();
```

### What changed and why

| Before | After | RFC / Spec |
|--------|-------|------------|
| `200 OK` + `{ "error": "invalid" }` | `422 Unprocessable Entity` + `ValidationProblemDetails` | RFC 7807; RFC 9110 §15.5.21 |
| `200 OK` on create | `201 Created` + `Location: /v1/orders/{id}` | RFC 7231 §6.3.2 |
| No idempotency | `Idempotency-Key` header + replay cache | Stripe / IETF draft-ietf-httpapi-idempotency-key-header |
| EF entity as DTO | Dedicated `CreateOrderResponse` record | No schema coupling to DB |
| No `[ProducesResponseType]` | Full annotations for 201, 422, 409 | OpenAPI / Swashbuckle contract accuracy |
| Unversioned route | `v{version:apiVersion}/orders` via `Asp.Versioning` | Breaking-change safety |
