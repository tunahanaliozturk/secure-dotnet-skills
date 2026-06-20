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

    // Delegated scope policy (user-interactive flows): token must contain
    // scp claim with "Admin.Read". Use for human-facing admin clients.
    options.AddPolicy("AdminRead", policy =>
        policy
            .RequireAuthenticatedUser()
            .RequireClaim("scp", "Admin.Read"));

    // App-role policy (daemon / service-to-service flows): token must contain
    // roles claim with "Admin.Write". Use for automated or service callers.
    options.AddPolicy("AdminWrite", policy =>
        policy
            .RequireAuthenticatedUser()
            .RequireClaim("roles", "Admin.Write"));
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

    // FIX 4 — named policy enforces the Admin.Read scope.
    // Only tokens that carry scp=Admin.Read are admitted.
    [Authorize(Policy = "AdminRead")]
    [HttpGet("users")]
    public async Task<IActionResult> ListAllUsers() =>
        Ok(await _users.GetAllAsync());

    // FIX 5 — named policy enforces the Admin.Write app role.
    // Only service principals (or users) with the Admin.Write role are admitted.
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

**Fix 4 & 5 — `[Authorize(Policy = "AdminRead")]` and `[Authorize(Policy = "AdminWrite")]`:**
Named policies layer a claim requirement on top of authentication. `scp` is the standard delegated-permission claim issued in user-interactive flows (Authorization Code, On-Behalf-Of); `roles` is the standard app-role claim issued in client-credentials (daemon) flows. Using the correct claim for each flow prevents a low-privileged user token from satisfying a daemon-tier check, and vice versa.
