---
name: threat-model-endpoint
description: Use when threat-modeling an API endpoint, feature, or data flow in an ASP.NET Core app — to enumerate STRIDE threats and concrete mitigations before building or shipping.
---

# Threat-Model Endpoint

Directs the agent to walk an ASP.NET Core endpoint or data flow through all six STRIDE categories, enumerate concrete threats for that specific surface, rank them by likelihood × impact, and produce a threat table that names the .NET mitigation and its current status (present or missing).

## When to use

- A new or modified API endpoint crosses a trust boundary (anonymous caller, external system, elevated privilege, sensitive data).
- A feature introduces a funds transfer, authentication change, PII write, or privilege escalation path.
- A security design review is required before a sprint ships to staging or production.
- Post-incident: confirming a class of threat is fully covered across a data flow.

## Process

1. **Name the asset, actors, and trust boundaries.** State what data the endpoint reads or writes, who can call it (anonymous, authenticated user, service account, admin), and which trust boundaries the request crosses (network edge → API → database, or API → downstream service).
2. **Walk STRIDE in order.** Address every category — Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, Elevation of Privilege — even if you assess a category as low risk. Skipping silently is a process failure.
3. **For each category, enumerate the concrete threats for this endpoint.** A concrete threat names the attacker goal and the attack vector, not just the abstract label. "Attacker replays a captured JWT to impersonate the transferring user" is concrete; "spoofing could occur" is not.
4. **Rank by likelihood × impact.** Use Critical / High / Medium / Low. Likelihood factors: attacker reachability (unauthenticated vs authenticated), input control, and known exploitation patterns. Impact factors: data sensitivity, financial effect, blast radius.
5. **For each threat, note the mitigation and whether it is present or missing.** Name the ASP.NET Core API, configuration key, or policy that provides the mitigation. "Present" means verifiably wired in the current code; "Missing" means the control is absent or incorrectly configured.
6. **Output a short threat table** (STRIDE category | threat | likelihood × impact | mitigation | status). Surface Critical and High findings as explicit action items at the top.

## .NET / Azure checks

### Spoofing

- **Authentication scheme and JWT validation parameters.** Confirm `AddAuthentication().AddJwtBearer(...)` sets `TokenValidationParameters` with `ValidateIssuer = true`, `ValidateAudience = true`, `ValidateLifetime = true`, `ValidateIssuerSigningKey = true`, and a non-null `IssuerSigningKey`. A misconfigured parameter silently accepts forged or expired tokens.
- **Entra ID integration via `Microsoft.Identity.Web`.** Prefer `AddMicrosoftIdentityWebApi(builder.Configuration.GetSection("AzureAd"))` over hand-rolled JWT options; it validates issuer, audience (`api://<clientId>`), and `tid`/`oid` claims automatically and handles multi-tenant and B2C variants.
- **Short token lifetimes and clock skew.** Confirm `ClockSkew` is not inflated beyond a few minutes (default is 5 min — acceptable). Long-lived access tokens (`exp` hours away) expand the replay window if a token is stolen.
- **Service-to-service identity.** Downstream service calls should use a managed identity + `DefaultAzureCredential`; client-secret credentials stored in config are a spoofing risk if the secret leaks.

### Tampering

- **Model validation on every state-changing request.** Confirm `DataAnnotations` or FluentValidation runs before the handler body executes (via `[ApiController]` automatic 400 response or a MediatR pipeline behavior). Unvalidated numeric fields, enums, or monetary amounts enable business-logic tampering.
- **Signed or encrypted tokens for values that must not be altered.** If the endpoint consumes a value from a cookie, query string, or header that encodes server-side state (e.g., a transfer token or idempotency seed), it must be protected with `IDataProtectionProvider.CreateProtector("purpose").Protect(...)` / `Unprotect(...)` — not base64 or weak HMAC.
- **Integrity of persisted data and optimistic concurrency.** For records that must not be silently overwritten by concurrent writers, confirm a concurrency token (`[Timestamp]` / `IsRowVersion()` in EF Core) is in use. Without it, a race between two valid requests can result in a lost-update attack where the last writer wins regardless of business rules.
- **Audit trail immutability.** Confirm that audit records written by the endpoint cannot be altered by the same caller that triggered them (write to append-only storage, Azure immutable Blob, or Event Hub).

### Repudiation

- **Structured audit logging with correlation and trace ids.** Every state-changing operation must emit a log entry that includes: the authenticated caller identity (`sub`, `oid`, or `nameidentifier` claim), the action taken, the affected resource id, the outcome, and the W3C `traceparent` / ASP.NET Core `HttpContext.TraceIdentifier`. Use `ILogger` message templates with named placeholders — never string interpolation.
- **Log sink durability.** Confirm logs flow to a durable, tamper-resistant sink (Azure Monitor / Log Analytics workspace, Application Insights, or a SIEM). Local file sinks are insufficient for repudiation-critical operations.
- **Do not log what should not be logged, and do not omit what must be.** PII and secrets must be excluded; but caller id, resource id, and outcome must always be present so that a denial cannot succeed.

### Information Disclosure

- **Response DTOs, not EF entities.** Confirm the endpoint returns a purpose-built response DTO, not the EF entity directly. Returning an `ApplicationUser` or `Transfer` entity exposes all mapped columns — including internal flags, password hashes, or soft-delete markers — to the caller. Use `Select(e => new TransferDto { … })` or AutoMapper with an explicit profile.
- **`ProblemDetails` without internal stack traces.** Confirm production uses `app.UseExceptionHandler(...)` (not `app.UseDeveloperExceptionPage()`) and that `ProblemDetails` responses (`builder.Services.AddProblemDetails()`) do not include the exception `detail` or `stackTrace` fields. An unhandled exception leaking an EF connection string or file path in the response body is a High finding.
- **No PII or secrets in logs or trace attributes.** Review every `_logger.Log…` call near the endpoint. Token values, passwords, card numbers, and national-id fields must not appear in log messages or OpenTelemetry span attributes. Use redaction (`LoggerMessage.Define` with structured templates and a redacting enricher, or ASP.NET Core's `IRedactedLogValue`).
- **Enumeration resistance.** Resource ids in responses should not be sequential integers if enumeration risk exists; prefer UUIDs or opaque tokens. 404 and 403 responses should not distinguish "not found" from "found but not yours" to a caller who should not know the resource exists.

### Denial of Service

- **Rate limiting on expensive or anonymous endpoints.** Confirm `builder.Services.AddRateLimiter(...)` is registered and `app.UseRateLimiter()` is in the pipeline. Apply a fixed-window or sliding-window policy to anonymous endpoints; a token-bucket or concurrency limiter to authenticated but expensive operations (e.g., funds transfers, PDF generation, bulk imports).
- **Request body size limits.** ASP.NET Core's default is 30 MB for form requests. For endpoints that do not accept file uploads, lower the limit via `[RequestSizeLimit(65_536)]` or `builder.WebHost.ConfigureKestrel(k => k.Limits.MaxRequestBodySize = …)`.
- **Timeouts on downstream calls.** `HttpClient` instances registered via `IHttpClientFactory` must have `Timeout` configured or a `Polly`/`Microsoft.Extensions.Http.Resilience` policy with a timeout. An uncapped outbound call to a slow dependency can exhaust the ASP.NET Core thread pool.
- **Async I/O throughout the call stack.** Confirm the endpoint and all called services use `async`/`await` with `CancellationToken` propagation. A synchronous blocking call (`.Result`, `.Wait()`) holds a thread-pool thread, making the service vulnerable to thread-pool exhaustion under load.
- **Pagination on collection endpoints.** Confirm any endpoint that returns a list enforces a maximum page size (`Math.Min(pageSize, 100)` or similar). An unbounded `_db.Transfers.ToListAsync()` can return millions of rows and exhaust memory.

### Elevation of Privilege

- **Authorization policies beyond bare `[Authorize]`.** `[Authorize]` alone only confirms the caller is authenticated. For sensitive operations, require an explicit policy: `[Authorize(Policy = "TransferApprover")]` backed by `AddAuthorization(opts => opts.AddPolicy("TransferApprover", p => p.RequireClaim("scp", "Transfers.Write").RequireRole("FinanceUser")))`. Never gate a funds transfer or admin action on authentication alone.
- **`scp` and `roles` claim validation.** For Entra ID-issued tokens, confirm the endpoint checks the `scp` (delegated) or `roles` (app) claim for the required scope/role — not just that a valid token exists. `Microsoft.Identity.Web` exposes `[RequiredScope("Transfers.Write")]` and `[RequiredScopeOrAppPermission(...)]` attributes for this.
- **Least-privilege managed identity.** If the endpoint calls Azure services (Storage, Key Vault, Service Bus), the managed identity must hold only the roles required for those calls (`Key Vault Secrets User`, `Storage Blob Data Contributor`). An identity with `Contributor` at the subscription scope is an elevation vector if the endpoint is compromised.
- **Fallback policy = `RequireAuthenticatedUser`.** Register `AddAuthorization(opts => opts.FallbackPolicy = new AuthorizationPolicyBuilder().RequireAuthenticatedUser().Build())` so that any endpoint that inadvertently lacks an `[Authorize]` attribute is still protected. Without this, adding a new controller without decoration makes it anonymously accessible.

## Red flags

| Signal | Why it matters |
|--------|----------------|
| `[Authorize]` with no policy name on a funds-transfer or admin endpoint | Authentication only — any valid user can invoke it regardless of role or scope; a compromised low-privilege account can escalate. |
| `ValidateAudience = false` in `JwtBearerOptions` | Tokens issued for any audience (any app) are accepted, enabling cross-service token replay by an attacker who obtains a token for a different resource. |
| Endpoint returns an EF entity type directly from the handler | All mapped columns — including internal flags, soft-delete markers, and sensitive fields — are serialized to the caller; information disclosure and overposting risk on write paths. |
| No `AddRateLimiter` / `UseRateLimiter` on an unauthenticated or expensive endpoint | Open to brute-force, credential-stuffing, or resource-exhaustion attacks with no server-side throttle. |
| Request body size not restricted below the Kestrel default (30 MB) on a non-upload endpoint | A single malicious request can allocate tens of megabytes of memory per connection; amplified across concurrent connections this exhausts the process. |
| `app.UseDeveloperExceptionPage()` active in production, or `ProblemDetails` emitting stack traces | Unhandled exceptions leak call stacks, file paths, connection strings, and internal type names to unauthenticated callers. |
| No audit log entry for a state-changing operation | A caller can deny performing the operation; regulatory compliance (PCI DSS, SOX, GDPR) typically mandates an immutable audit trail for financial or PII-touching writes. |
| `_logger.LogInformation($"Transfer {amount} for user {email}")` (interpolated, not structured) | String interpolation bakes PII into the log message without structured fields; redaction is impossible after the fact, and the log sink sees the raw value. |

## Example

See [`examples/threat-model-endpoint/`](../../examples/threat-model-endpoint/).
