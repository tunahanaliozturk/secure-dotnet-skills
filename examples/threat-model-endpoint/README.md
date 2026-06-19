# Example — Threat Model: `POST /transfers`

This worked example applies the `threat-model-endpoint` skill to a funds-transfer endpoint in a fictional ASP.NET Core banking API. The endpoint lets an authenticated user initiate a transfer from one of their accounts to any destination account number.

## Endpoint overview

```csharp
// POST /transfers
// Accepts: { fromAccountId, toAccountNumber, amount, currency, idempotencyKey }
// Returns: { transferId, status }
// Auth: JWT Bearer (Entra ID)

[ApiController]
[Route("[controller]")]
public class TransfersController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly ITransferService _svc;

    public TransfersController(AppDbContext db, ITransferService svc)
    {
        _db = db;
        _svc = svc;
    }

    [Authorize]
    [HttpPost]
    public async Task<IActionResult> Create([FromBody] TransferRequest request)
    {
        var transfer = await _svc.ExecuteAsync(request);
        return Ok(transfer);   // returns the Transfer EF entity
    }
}
```

**Trust boundaries crossed:** External caller (internet) → ASP.NET Core API → PostgreSQL (via EF Core) → outbound ACH/payment-rail service.

**Asset:** Financial account balances and transfer records; PII (account numbers, IBAN).

---

## STRIDE Threat Table

| STRIDE Category | Concrete Threat | Likelihood × Impact | Mitigation | .NET Mechanism | Status |
|---|---|---|---|---|---|
| **Spoofing** | Attacker replays a stolen JWT or crafts a token signed by a different issuer to impersonate a legitimate user and initiate transfers on their behalf. | Medium × Critical = **Critical** | Strict JWT validation: issuer, audience, lifetime, and signing key must all be validated. Use Entra ID integration. | `AddMicrosoftIdentityWebApi(config.GetSection("AzureAd"))` with correct `Instance`, `TenantId`, `ClientId` in `appsettings.json`; `ValidateIssuer = true`, `ValidateAudience = true`, `ValidateLifetime = true`, `ValidateIssuerSigningKey = true` | **MISSING — `ValidateAudience` is currently `false` in `appsettings.json`** |
| **Tampering** | Attacker submits a negative `amount` or a `fromAccountId` that belongs to another user, bypassing business-rule checks and diverting funds. | High × Critical = **Critical** | Model validation (non-negative amount, currency allowlist) and server-side ownership check on `fromAccountId` before executing the transfer. | `[Range(0.01, 1_000_000)]` on `Amount`; `[EnumDataType(typeof(Currency))]` on `Currency`; explicit `_db.Accounts.SingleAsync(a => a.Id == request.FromAccountId && a.OwnerId == currentUserId)` before debit | **MISSING — ownership predicate absent; amount validated but currency accepted as free-form string** |
| **Repudiation** | User denies initiating a transfer; without an audit trail the institution cannot prove the request was made by that user from that session. | Low × High = **High** | Structured audit log entry per transfer: caller `sub`/`oid` claim, `fromAccountId`, `toAccountNumber`, `amount`, outcome, and W3C `traceparent`. Logs shipped to tamper-resistant Azure Monitor workspace. | `_logger.LogInformation("Transfer initiated by {UserId} from {FromAccount} amount {Amount} {Currency} traceId {TraceId}", userId, fromAccountId, amount, currency, HttpContext.TraceIdentifier)` + Log Analytics workspace with immutable archival | **PARTIAL — logging present but uses string interpolation (`$"..."`) rather than structured template; trace id not included** |
| **Information Disclosure** | The response body serializes the full `Transfer` EF entity, exposing internal fields: `ProcessingFee`, `InternalRailCode`, `FailureReason`, `IsDeleted`. Stack traces from unhandled exceptions appear in 500 responses in the test environment (which shares a config base with production). | Medium × High = **High** | Return a purpose-built `TransferDto`; configure `UseExceptionHandler` in production; `AddProblemDetails()` must not include `detail` or stack in non-development environments. | `return Ok(new TransferDto { TransferId = transfer.Id, Status = transfer.Status });`; `builder.Services.AddProblemDetails(); app.UseExceptionHandler();`; environment check guards `UseDeveloperExceptionPage()` | **MISSING — entity returned directly; `UseDeveloperExceptionPage()` is active when `ASPNETCORE_ENVIRONMENT != Production` including the shared test environment** |
| **Denial of Service** | Attacker floods `POST /transfers` without authentication (401 path is cheap) or with valid tokens at high rate to exhaust database connections and the ACH rail's rate limits, causing service unavailability for legitimate users. | High × High = **High** | Fixed-window rate limiter per IP on the unauthenticated path; token-bucket limiter per `sub` claim on the authenticated path. Request body capped well below Kestrel default. | `builder.Services.AddRateLimiter(opts => { opts.AddFixedWindowLimiter("per-ip", o => { o.PermitLimit = 10; o.Window = TimeSpan.FromMinutes(1); }); opts.AddTokenBucketLimiter("per-user", o => { o.TokenLimit = 5; o.ReplenishmentPeriod = TimeSpan.FromSeconds(10); }); });` + `[RequestSizeLimit(8_192)]` on the action | **MISSING — no `AddRateLimiter` registered; default 30 MB body limit in effect** |
| **Elevation of Privilege** | An authenticated but low-privilege user (customer support role) calls `POST /transfers` because the endpoint only requires `[Authorize]` (any valid token) rather than a specific scope or role, allowing them to initiate transfers they are not permitted to make. | Medium × Critical = **Critical** | Require the `Transfers.Write` delegated scope or the `FinanceUser` app role on the endpoint; register a named authorization policy. | `[Authorize(Policy = "CanInitiateTransfer")]` + `builder.Services.AddAuthorization(opts => opts.AddPolicy("CanInitiateTransfer", p => p.RequireClaim("scp", "Transfers.Write")));`; alternatively `[RequiredScope("Transfers.Write")]` from `Microsoft.Identity.Web` | **MISSING — bare `[Authorize]` only; any Entra ID user with a valid token can POST** |

---

## Findings summary

**Critical (block ship):**

1. `ValidateAudience = false` — tokens from any Entra ID app are accepted. Fix: set `ValidateAudience = true` and specify `Audience = "api://<clientId>"` in `JwtBearerOptions`, or switch to `AddMicrosoftIdentityWebApi`.
2. No `fromAccountId` ownership check — any authenticated user can debit any account id. Fix: add `&& a.OwnerId == User.FindFirstValue("oid")` to the EF query before executing the transfer.
3. Bare `[Authorize]` with no scope/role policy — any Entra ID user can initiate transfers. Fix: add `[Authorize(Policy = "CanInitiateTransfer")]` with `RequireClaim("scp", "Transfers.Write")`.

**High (fix before next sprint ships):**

4. EF entity returned directly — internal fields exposed. Fix: project to `TransferDto`.
5. `UseDeveloperExceptionPage()` reachable in test environment sharing production config base. Fix: guard strictly on `IHostEnvironment.IsDevelopment()`.
6. No rate limiting. Fix: `AddRateLimiter` + `UseRateLimiter` with per-IP and per-user policies; `[RequestSizeLimit(8_192)]` on the action.
7. Audit log uses string interpolation and omits trace id. Fix: switch to structured message template; include `HttpContext.TraceIdentifier`.

---

## Fixed handler (key changes only)

```csharp
[Authorize(Policy = "CanInitiateTransfer")]   // scope/role enforced
[HttpPost]
[RequestSizeLimit(8_192)]
public async Task<IActionResult> Create(
    [FromBody] TransferRequest request,
    CancellationToken ct)
{
    var userId = User.FindFirstValue("oid")
        ?? throw new UnauthorizedAccessException();

    // Ownership check — IDOR prevention
    var fromAccount = await _db.Accounts
        .SingleOrDefaultAsync(a => a.Id == request.FromAccountId
                                && a.OwnerId == userId, ct)
        ?? throw new NotFoundException();

    var transfer = await _svc.ExecuteAsync(fromAccount, request, ct);

    _logger.LogInformation(
        "Transfer {TransferId} initiated by {UserId} from {FromAccountId} " +
        "amount {Amount} {Currency} traceId {TraceId}",
        transfer.Id, userId, fromAccount.Id,
        request.Amount, request.Currency,
        HttpContext.TraceIdentifier);

    // Return DTO, not entity
    return Ok(new TransferDto { TransferId = transfer.Id, Status = transfer.Status });
}
```

```csharp
// Program.cs — wiring the missing controls
builder.Services.AddMicrosoftIdentityWebApi(builder.Configuration.GetSection("AzureAd"));

builder.Services.AddAuthorization(opts =>
{
    opts.FallbackPolicy = new AuthorizationPolicyBuilder()
        .RequireAuthenticatedUser()
        .Build();
    opts.AddPolicy("CanInitiateTransfer",
        p => p.RequireClaim("scp", "Transfers.Write"));
});

builder.Services.AddRateLimiter(opts =>
{
    opts.AddFixedWindowLimiter("per-ip", o =>
    {
        o.PermitLimit = 10;
        o.Window = TimeSpan.FromMinutes(1);
        o.QueueProcessingOrder = QueueProcessingOrder.OldestFirst;
        o.QueueLimit = 0;
    });
    opts.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
});

builder.Services.AddProblemDetails();

var app = builder.Build();
app.UseRateLimiter();
app.UseAuthentication();
app.UseAuthorization();
if (!app.Environment.IsProduction())
    app.UseDeveloperExceptionPage();
else
    app.UseExceptionHandler();
```
