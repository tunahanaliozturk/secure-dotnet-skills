# Example: design-dotnet-feature

A worked feature design for **"Redeem License Key"** — a user submits a single-use license key and receives an activated subscription in return. This is an unsafe, state-changing operation with strict invariants, making it a good stress-test for every design lens.

---

## Use case statement

**Actor:** Authenticated user  
**Trigger:** `POST /licenses/redeem` with a key string in the request body  
**Preconditions:** The key exists in the catalog, has not already been redeemed, and has not expired  
**Postcondition:** The key is marked `Redeemed`, a `Subscription` record is created for the user, and the user receives a confirmation email  
**Invariant:** No key may be redeemed more than once, even under concurrent requests

---

## Layer boundaries and operation classification

| Layer | Owns |
|-------|------|
| Domain | `LicenseKey` aggregate, `Subscription` entity, domain events (`LicenseKeyRedeemedEvent`) |
| Application | `RedeemLicenseKeyCommand` + `RedeemLicenseKeyHandler`, `RedeemLicenseKeyValidator`, `IEmailSender` interface |
| Infrastructure | EF Core `DbContext`, `EmailSender` (via SendGrid), `IdempotencyRecord` table |
| API | `POST /licenses/redeem` minimal-API endpoint; translates `Result` to `ProblemDetails` |

Classification: **command** (mutates state, has side effects). One handler, never reused for a "check if key is valid" query (that is a separate, read-only `IRequest`).

---

## Contracts

### Request DTO

```csharp
// Application/Features/Licenses/RedeemLicenseKeyCommand.cs
public sealed record RedeemLicenseKeyCommand(
    Guid   UserId,        // populated from ClaimsPrincipal by the endpoint, not trusted from body
    string LicenseKey,    // the raw key string submitted by the user
    Guid   IdempotencyKey // from Idempotency-Key header
) : IRequest<Result<RedeemLicenseKeyResponse>>;
```

### Response DTO

```csharp
public sealed record RedeemLicenseKeyResponse(
    Guid   SubscriptionId,
    string Plan,
    DateTimeOffset ExpiresAt
);
```

`UserId` is populated by the endpoint from `HttpContext.User` — it is never read from the request body to prevent elevation of privilege.

### Domain event

```csharp
public sealed record LicenseKeyRedeemedEvent(
    Guid LicenseKeyId,
    Guid UserId,
    DateTimeOffset RedeemedAt
) : IDomainEvent;
```

Raised inside the aggregate after redemption; dispatched by a MediatR `INotificationHandler` to trigger the confirmation email asynchronously, keeping the handler's transaction boundary tight.

---

## Validation strategy

Use **FluentValidation** registered as a MediatR pipeline behavior. The behavior runs before the handler and short-circuits with a `Result.Failure(Error.Validation(...))` (mapped to HTTP 422) if any rule fails.

```csharp
// Application/Features/Licenses/RedeemLicenseKeyValidator.cs
public sealed class RedeemLicenseKeyValidator
    : AbstractValidator<RedeemLicenseKeyCommand>
{
    public RedeemLicenseKeyValidator()
    {
        RuleFor(x => x.LicenseKey)
            .NotEmpty()
            .Length(16, 32)
            .Matches(@"^[A-Z0-9\-]+$").WithMessage("Key contains invalid characters.");

        RuleFor(x => x.IdempotencyKey)
            .NotEmpty().WithMessage("Idempotency-Key header is required.");
    }
}
```

**What the validator does NOT do:**
- It does not query the DB to check whether the key exists or has already been redeemed. That is a domain invariant enforced inside the aggregate inside the handler's transaction — checking it here creates a TOCTOU race.
- It does not call `IEmailSender` or any external service.

---

## Error model

| Failure case | Classification | `Result` error code | HTTP status | `ProblemDetails.type` |
|--------------|---------------|--------------------|-----------|-----------------------|
| Key not found | Expected domain outcome | `LicenseKey.NotFound` | 404 | `.../errors/license-key/not-found` |
| Key already redeemed | Expected domain outcome | `LicenseKey.AlreadyRedeemed` | 409 | `.../errors/license-key/already-redeemed` |
| Key expired | Expected domain outcome | `LicenseKey.Expired` | 422 | `.../errors/license-key/expired` |
| Input validation failure | Input sanitization | `General.Validation` | 422 | `.../errors/validation` |
| Unhandled DB failure | Exceptional | (uncaught exception) | 500 | (handled by `UseExceptionHandler`) |

```csharp
// Application/Shared/Result.cs (simplified)
public sealed class Result<T>
{
    public T?    Value     { get; }
    public Error Error     { get; }
    public bool  IsSuccess { get; }

    public static Result<T> Success(T value) => ...;
    public static Result<T> Failure(Error error) => ...;
}

public sealed record Error(string Code, string Description)
{
    public static Error NotFound(string code, string description) => new(code, description);
    public static Error Conflict(string code, string description) => new(code, description);
    public static Error Validation(string code, string description) => new(code, description);
}
```

---

## Handler skeleton

```csharp
// Application/Features/Licenses/RedeemLicenseKeyHandler.cs
internal sealed class RedeemLicenseKeyHandler
    : IRequestHandler<RedeemLicenseKeyCommand, Result<RedeemLicenseKeyResponse>>
{
    private readonly AppDbContext       _db;
    private readonly IIdempotencyStore  _idempotency;
    private readonly IPublisher         _publisher;   // MediatR — dispatches domain events

    public RedeemLicenseKeyHandler(
        AppDbContext      db,
        IIdempotencyStore idempotency,
        IPublisher        publisher)
    {
        _db          = db;
        _idempotency = idempotency;
        _publisher   = publisher;
    }

    public async Task<Result<RedeemLicenseKeyResponse>> Handle(
        RedeemLicenseKeyCommand request,
        CancellationToken       cancellationToken)
    {
        // 1. Idempotency check (before touching the domain).
        var cached = await _idempotency.GetAsync<RedeemLicenseKeyResponse>(
            request.UserId, request.IdempotencyKey, cancellationToken);
        if (cached is not null)
            return Result<RedeemLicenseKeyResponse>.Success(cached);

        // 2. Load aggregate — single query, pessimistic lock to prevent race.
        var key = await _db.LicenseKeys
            .FromSqlInterpolated(
                $"SELECT * FROM \"LicenseKeys\" WHERE \"Key\" = {request.LicenseKey} FOR UPDATE")
            .SingleOrDefaultAsync(cancellationToken);

        if (key is null)
            return Result<RedeemLicenseKeyResponse>.Failure(
                Error.NotFound("LicenseKey.NotFound", "The license key does not exist."));

        // 3. Domain logic — aggregate enforces invariants; returns Result internally.
        var redeemResult = key.Redeem(request.UserId, DateTimeOffset.UtcNow);
        if (!redeemResult.IsSuccess)
            return Result<RedeemLicenseKeyResponse>.Failure(redeemResult.Error);

        // 4. Create subscription (same EF transaction).
        var subscription = Subscription.Create(request.UserId, key.Plan, key.DurationDays);
        _db.Subscriptions.Add(subscription);

        // 5. Single SaveChangesAsync — one transaction boundary.
        await _db.SaveChangesAsync(cancellationToken);

        // 6. Dispatch domain event (email sent in a separate handler, after commit).
        await _publisher.Publish(
            new LicenseKeyRedeemedEvent(key.Id, request.UserId, DateTimeOffset.UtcNow),
            cancellationToken);

        var response = new RedeemLicenseKeyResponse(
            subscription.Id, key.Plan, subscription.ExpiresAt);

        // 7. Persist idempotency record so duplicate requests get the same response.
        await _idempotency.SetAsync(
            request.UserId, request.IdempotencyKey, response,
            TimeSpan.FromHours(24), cancellationToken);

        return Result<RedeemLicenseKeyResponse>.Success(response);
    }
}
```

Key points:
- No business logic in the controller or the validator.
- One `SaveChangesAsync()` at step 5; domain event fires after commit.
- The `FOR UPDATE` lock prevents two concurrent requests from redeeming the same key simultaneously; `key.Redeem(...)` also enforces the invariant inside the aggregate so the domain is correct even without the DB lock.

---

## API endpoint

```csharp
// API/Endpoints/LicenseEndpoints.cs
app.MapPost("/licenses/redeem", async (
    [FromBody]   RedeemLicenseKeyRequest  body,
    [FromHeader(Name = "Idempotency-Key")] Guid idempotencyKey,
    ClaimsPrincipal user,
    ISender         sender,
    CancellationToken ct) =>
{
    var userId  = user.GetUserId();   // extension on ClaimsPrincipal — never trust body
    var command = new RedeemLicenseKeyCommand(userId, body.LicenseKey, idempotencyKey);
    var result  = await sender.Send(command, ct);

    return result.IsSuccess
        ? TypedResults.Ok(result.Value)
        : result.Error.ToProblemDetails();   // extension: maps Error → IResult (ProblemDetails)
})
.RequireAuthorization("ActiveUser")
.WithName("RedeemLicenseKey");
```

---

## Idempotency design

| Concern | Decision |
|---------|----------|
| Key source | `Idempotency-Key: <uuid>` request header — client-generated UUID v4 |
| Scope | `(userId, idempotencyKey)` — a key is scoped per user to prevent cross-user collision |
| Storage | `IdempotencyRecord` table in the same `AppDbContext`; columns: `UserId`, `IdempotencyKey`, `ResponseJson`, `CreatedAt` |
| TTL | 24 hours — purged by a nightly background job (`IHostedService`) |
| Race condition | Unique constraint on `(UserId, IdempotencyKey)` in the DB; `DbUpdateException` on duplicate insert is caught and treated as "already processed — return stored response" |
| Missing header | Validator rejects the request (HTTP 422) before the handler runs |

---

## DI registrations

```csharp
// Program.cs
builder.Services.AddMediatR(cfg =>
    cfg.RegisterServicesFromAssembly(typeof(RedeemLicenseKeyHandler).Assembly));

builder.Services.AddValidatorsFromAssembly(typeof(RedeemLicenseKeyValidator).Assembly);
builder.Services.AddScoped(typeof(IPipelineBehavior<,>), typeof(ValidationBehavior<,>));
builder.Services.AddScoped(typeof(IPipelineBehavior<,>), typeof(LoggingBehavior<,>));

builder.Services.AddScoped<IIdempotencyStore, EfIdempotencyStore>();
builder.Services.AddTransient<IEmailSender, SendGridEmailSender>();

builder.Services.AddProblemDetails();
app.UseExceptionHandler();
```

In tests, `SendGridEmailSender` is replaced with `FakeEmailSender : IEmailSender` via `WebApplicationFactory.ConfigureTestServices`.

---

## Ordered build slices

| # | Slice | What to build |
|---|-------|---------------|
| 1 | Domain | `LicenseKey` aggregate with `Redeem(userId, now)` method that enforces "not already redeemed" and "not expired"; `LicenseKeyRedeemedEvent`; `Subscription.Create(...)` factory |
| 2 | Application contracts | `RedeemLicenseKeyCommand`, `RedeemLicenseKeyResponse`, `IIdempotencyStore` interface |
| 3 | Validation | `RedeemLicenseKeyValidator`; unit-test all rules (empty key, bad format, missing idempotency key) |
| 4 | Handler | `RedeemLicenseKeyHandler`; integration test against an in-memory Sqlite or Testcontainers Postgres: happy path, not-found, already-redeemed, idempotent duplicate |
| 5 | Infrastructure | `AppDbContext` migrations (`LicenseKeys`, `Subscriptions`, `IdempotencyRecords`); `EfIdempotencyStore`; `SendGridEmailSender` behind feature flag |
| 6 | API endpoint | Minimal-API route; `ResultExtensions.ToProblemDetails()`; `Error.ToProblemDetails()` mapping table |
| 7 | Tests: idempotency | Send the same `Idempotency-Key` twice; assert second response is identical; assert DB has one `Subscription` row |
| 8 | Tests: concurrency | Two parallel requests with the same key — assert exactly one succeeds (409 for the loser); assert one `Subscription` row |
