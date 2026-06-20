# Example: auth-flow-review

A worked review of an ASP.NET Core Web API that wires up JWT bearer authentication with two common defects: `ValidateAudience = false` and admin endpoints protected by bare `[Authorize]` instead of a named policy enforcing an app role.

---

## BEFORE — misconfigured auth setup

### Program.cs (registration)

```csharp
// Program.cs
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.Authority = "https://login.microsoftonline.com/contoso.onmicrosoft.com/v2.0";

        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer    = true,
            ValidIssuer       = "https://login.microsoftonline.com/contoso.onmicrosoft.com/v2.0",

            // BUG 1 — audience validation disabled.
            // Any JWT issued by this authority for any application is accepted.
            ValidateAudience  = false,

            ValidateLifetime          = true,
            ValidateIssuerSigningKey  = true,

            // BUG 2 — excessive clock skew (2 hours).
            // Expired tokens remain valid for up to 2 hours after expiry.
            ClockSkew = TimeSpan.FromHours(2),
        };
    });

// BUG 3 — no fallback policy.
// Any endpoint that forgets [Authorize] is publicly reachable.
builder.Services.AddAuthorization();
```

### AdminController.cs

```csharp
// AdminController.cs
[ApiController]
[Route("api/[controller]")]
public class AdminController : ControllerBase
{
    private readonly IUserService _users;

    public AdminController(IUserService users) => _users = users;

    // BUG 4 — bare [Authorize] on a privileged endpoint.
    // Any authenticated user — regardless of role or scope — can list all users.
    [Authorize]
    [HttpGet("users")]
    public async Task<IActionResult> ListAllUsers() =>
        Ok(await _users.GetAllAsync());

    // BUG 5 — bare [Authorize] on a destructive action.
    // No role check; any token from the authority satisfies this.
    [Authorize]
    [HttpDelete("users/{id}")]
    public async Task<IActionResult> DeleteUser(Guid id)
    {
        await _users.DeleteAsync(id);
        return NoContent();
    }
}
```

---

## Findings

| # | Location | Severity | Finding | Why it matters |
|---|----------|----------|---------|----------------|
| 1 | `TokenValidationParameters.ValidateAudience = false` | **Critical** | Audience validation disabled | Any JWT issued by `login.microsoftonline.com/contoso.onmicrosoft.com` is accepted — including tokens minted for other apps in the same tenant. A compromised or malicious first-party app can present its own tokens to this API. |
| 2 | `ClockSkew = TimeSpan.FromHours(2)` | **High** | Excessive clock skew | Tokens that expired up to two hours ago are still accepted. A stolen short-lived token (15 min) remains valid for 2 h 15 min, negating the short-expiry protection. Acceptable ceiling is 5 minutes. |
| 3 | `AddAuthorization()` with no `FallbackPolicy` | **High** | No default-deny posture | Any controller or minimal-API handler added without an `[Authorize]` attribute is publicly reachable. As the service grows, omitting the attribute on a new endpoint is an invisible auth bypass. |
| 4 | `[Authorize]` on `GET /api/admin/users` | **High** | No role/scope enforcement on admin read | Bare `[Authorize]` checks only that a principal is authenticated. Any valid user token from the authority can list all users — not just administrators. |
| 5 | `[Authorize]` on `DELETE /api/admin/users/{id}` | **Critical** | No role/scope enforcement on destructive admin action | Same issue as #4, but the impact is data destruction. Any authenticated caller can delete any user. |

---

## AFTER — corrected configuration and policy

### Program.cs (registration)

```csharp
// Program.cs
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        // Prefer AddMicrosoftIdentityWebApi for Entra ID — it wires issuer,
        // audience, lifetime, and signing-key validation via OIDC metadata.
        // Shown here as explicit TokenValidationParameters for illustration.
        options.Authority = "https://login.microsoftonline.com/contoso.onmicrosoft.com/v2.0";
        options.RequireHttpsMetadata = true; // must be true outside Development

        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer   = true,
            ValidIssuer      = "https://login.microsoftonline.com/contoso.onmicrosoft.com/v2.0",

            // FIX 1 — validate the audience (Application ID URI or client id).
            ValidateAudience = true,
            ValidAudience    = "api://contoso-admin-api",  // match the app registration

            ValidateLifetime         = true,
            ValidateIssuerSigningKey = true,

            // FIX 2 — restore the default 5-minute clock skew.
            ClockSkew = TimeSpan.FromMinutes(5),
        };
    });

// FIX 3 — default-deny fallback policy + named admin policies.
builder.Services.AddAuthorization(options =>
{
    // Every endpoint that omits [Authorize] is denied by default.
    options.FallbackPolicy = new AuthorizationPolicyBuilder()
        .RequireAuthenticatedUser()
        .Build();

    // FIX 4 — delegated scope policy (user-interactive flows).
    // Reads are delegated user calls via scp; RequireScope handles the
    // space-delimited scp string correctly (e.g. "Admin.Read Admin.Write")
    // where a bare RequireClaim("scp", "Admin.Read") would deny valid tokens.
    options.AddPolicy("AdminRead", policy =>
        policy
            .RequireAuthenticatedUser()
            .RequireScope("Admin.Read"));   // Microsoft.Identity.Web

    // FIX 5 — app-role policy (daemon / service-to-service flows).
    // The destructive delete is restricted to a service principal app role via
    // roles; RequireRole maps correctly to ClaimTypes.Role as wired by
    // Microsoft.Identity.Web, whereas RequireClaim("roles","…") can fail closed.
    options.AddPolicy("AdminWrite", policy =>
        policy
            .RequireAuthenticatedUser()
            .RequireRole("Admin.Write"));
});
```

### AdminController.cs

```csharp
// AdminController.cs
[ApiController]
[Route("api/[controller]")]
public class AdminController : ControllerBase
{
    private readonly IUserService _users;

    public AdminController(IUserService users) => _users = users;

    // FIX 4 — named policy enforces the Admin.Read scope via RequireScope.
    // Reads are delegated user calls; RequireScope tokenizes the space-delimited
    // scp claim so "Admin.Read Admin.Write" still satisfies an Admin.Read policy.
    [Authorize(Policy = "AdminRead")]
    [HttpGet("users")]
    public async Task<IActionResult> ListAllUsers() =>
        Ok(await _users.GetAllAsync());

    // FIX 5 — named policy enforces the Admin.Write app role via RequireRole.
    // The destructive delete is restricted to service principals carrying the
    // Admin.Write app role; RequireRole maps to ClaimTypes.Role as wired by
    // Microsoft.Identity.Web, ensuring daemon tokens are correctly admitted.
    [Authorize(Policy = "AdminWrite")]
    [HttpDelete("users/{id}")]
    public async Task<IActionResult> DeleteUser(Guid id)
    {
        await _users.DeleteAsync(id);
        return NoContent();
    }
}
```

---

### Why each fix works

**Fix 1 — `ValidateAudience = true` with `ValidAudience`:**
Audience validation ensures the token was explicitly issued *for this API*. The `aud` claim in a JWT must match `ValidAudience`; Entra ID sets it to the Application ID URI (`api://…`) or the client ID of the resource application. Without this check, token-substitution attacks are possible — a caller presents a token obtained for a different app registered in the same tenant.

**Fix 2 — `ClockSkew = TimeSpan.FromMinutes(5)`:**
Clock skew tolerance exists only to absorb small clock-sync differences between the token issuer and the consuming server. Five minutes is the ASP.NET Core default and an accepted industry ceiling. Two hours extends the validity window of any stolen token by the full skew duration; it also suggests the real problem (a misconfigured server clock) should be fixed at the infrastructure level rather than papered over in code.

**Fix 3 — `FallbackPolicy = RequireAuthenticatedUser`:**
With a fallback policy, any endpoint that omits an explicit `[Authorize]` attribute is denied by the authorization middleware rather than served openly. Public routes (health checks, OIDC callback, anonymous status endpoints) opt out explicitly with `[AllowAnonymous]`, making anonymous access a deliberate and visible decision rather than a silent default.

**Fix 4 — `[Authorize(Policy = "AdminRead")]` with `RequireScope("Admin.Read")`:**
The `scp` claim in Entra ID tokens is a **space-delimited string** (e.g. `"Admin.Read Admin.Write"`). `RequireClaim("scp", "Admin.Read")` performs an exact-value match and would deny any token that carries more than one scope. `Microsoft.Identity.Web`'s `RequireScope("Admin.Read")` tokenizes the string and checks for the presence of the required scope, so valid tokens with multiple scopes are never rejected. Reads are delegated user-interactive calls (Authorization Code / On-Behalf-Of flows) — the caller is a human-facing admin client acting on behalf of a user.

**Fix 5 — `[Authorize(Policy = "AdminWrite")]` with `RequireRole("Admin.Write")`:**
The destructive delete is restricted to service principals (daemon callers, automated pipelines) that hold the `Admin.Write` app role — these arrive via client-credentials grant and carry a `roles` claim, not `scp`. Under `Microsoft.Identity.Web`, the `roles` claim is mapped to `ClaimTypes.Role`; using `RequireRole("Admin.Write")` respects that mapping, whereas `RequireClaim("roles", "Admin.Write")` bypasses it and can fail closed against valid tokens. This intentional split — delegated `scp` for reads, app-role `roles` for the destructive write — means human users can list data but only trusted service identities can delete it.
