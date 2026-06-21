---
name: secrets-config-audit
description: Use when auditing a .NET app for secret handling and configuration safety — hardcoded secrets, secrets in source or appsettings, Azure Key Vault wiring, and managed-identity usage.
---

# Secrets & Config Audit

Directs the agent to audit a .NET / ASP.NET Core application for secret-handling failures and configuration-provider gaps, producing a concrete remediation path for each finding — naming the Key Vault API, `DefaultAzureCredential` pattern, or config-layer fix required.

## When to use

- Any PR or codebase audit where connection strings, API keys, client secrets, SAS tokens, or passwords may appear in source or `appsettings*.json`.
- Before onboarding an app to Azure: confirming Key Vault is wired, managed identity is used, and no raw secrets travel through environment variables or app settings.
- Post-incident: validating that a leaked secret has been rotated and the root cause (wrong config layer) is fixed.
- Pre-deploy security gate for any .NET service that calls Azure Storage, Azure SQL, Cognitive Services, or third-party APIs.

## Process

1. **Scan source and `appsettings*.json` for literal secrets.** Search for `Password=`, `ClientSecret`, `AccountKey`, `SharedAccessSignature`, `apiKey`, bearer token literals, and connection-string patterns. Flag every occurrence, including `appsettings.Development.json` — development files are committed and leak via git history.
2. **Map the configuration layering and decide where each secret belongs.** Trace the config provider registration order in `Program.cs` (`appsettings.json` → `appsettings.{Environment}.json` → environment variables → user-secrets → Key Vault). Assign each secret to its correct layer: non-sensitive defaults in `appsettings.json`, development-only values in `dotnet user-secrets`, production secrets exclusively in Key Vault.
3. **Verify Key Vault integration and its authentication.** Confirm `AddAzureKeyVault(new Uri(vaultUri), new DefaultAzureCredential())` is registered in `Program.cs`, that `KeyVault:VaultUri` (or equivalent) is the only Key Vault-related value in `appsettings.json`, and that no `ClientId`/`ClientSecret` pair is stored in config to authenticate to Key Vault itself — that is the managed-identity anti-pattern.
4. **Confirm logging and exception paths never emit secrets.** Review every `ILogger` call, exception handler, and `IOptions<T>` binding near sensitive config sections. A `LogInformation` call that dumps an `IOptions<DatabaseOptions>` instance, or a caught exception that formats a connection string, silently exfiltrates secrets to the log sink.
5. **Give a remediation path per finding.** Each finding must name the specific config value to remove, the Key Vault secret name to create (observing the `:`→`--` naming rule), the RBAC role to grant, and the code change required in `Program.cs`. "Move to Key Vault" is not a remediation; the exact secret name, vault URI source, and `AddAzureKeyVault` wiring are.

## .NET / Azure checks

- **Literal secrets in source or committed config.** Flag any `"Password=…"`, `"ClientSecret"`, `"AccountKey"`, `"SharedAccessSignature"`, or API key value in `appsettings*.json`, `*.json` resource files, `web.config`, `.env` files, or C# string literals. Even `appsettings.Development.json` is committed; secrets there are in git history permanently after removal.
- **Config provider order and secret layer assignment.** In `Program.cs`, confirm the host builder registers providers in the correct order: `appsettings.json` (non-sensitive defaults) → `appsettings.{env}.json` (env-specific non-sensitive) → environment variables → `builder.Configuration.AddUserSecrets<Program>()` (dev only; never in production) → `AddAzureKeyVault(...)` (production secrets). Secrets surfacing from the wrong layer (e.g., a production password in an environment variable on App Service instead of Key Vault) are a misconfiguration finding.
- **`AddAzureKeyVault` wiring with `DefaultAzureCredential`.** Confirm `Program.cs` calls `builder.Configuration.AddAzureKeyVault(new Uri(builder.Configuration["KeyVault:VaultUri"]!), new DefaultAzureCredential())`. The vault URI must itself come from a non-secret config value (it is not a secret). Prefer `DefaultAzureCredential` over `ClientSecretCredential` — any `ClientSecretCredential` that takes a secret from config is an anti-pattern: the secret that authenticates to Key Vault must not live in config.
- **Managed identity vs client secret for Azure service authentication.** Flag any `ClientId` + `ClientSecret` pair in config used to authenticate to Azure services (Key Vault, Storage, Service Bus, SQL). The correct pattern for App Service / Container Apps / AKS is a system-assigned or user-assigned managed identity with `DefaultAzureCredential`; no credential material touches config or code. For local development, `DefaultAzureCredential` falls through to `VisualStudioCredential` / `AzureCliCredential` — no secret required there either.
- **Key Vault secret naming for nested config (`:`→`--`).** Azure Key Vault does not allow `:` in secret names. The Key Vault configuration provider maps `--` to `:` at read time, so `ConnectionStrings:DefaultConnection` must be stored as the Key Vault secret `ConnectionStrings--DefaultConnection`, and `AzureAd:ClientSecret` as `AzureAd--ClientSecret`. Verify that the secret names in Key Vault match the config keys the app reads; a mismatch silently falls back to the lower-priority provider (which may still hold a stale literal).
- **RBAC vs legacy access policies on Key Vault.** Key Vault supports two authorization models: the modern Azure RBAC model (grant `Key Vault Secrets User` to read secrets, `Key Vault Secrets Officer` to create/update) and the legacy access-policy model. Flag any vault configured with access policies — the RBAC model is auditable via Azure Policy, scoped to individual secrets, and aligns with the principle of least privilege. `Key Vault Secrets User` is sufficient for app reads; `Key Vault Secrets Officer` is required for deployment pipelines that write secrets. Flag `Key Vault Contributor` or `Owner` on an app identity — these are resource-plane roles, not data-plane roles, and do not grant secret reads but do grant the ability to reconfigure the vault.
- **Storage: SAS/account keys vs RBAC.** Flag any Azure Storage `AccountKey` or SAS token in config. The correct pattern is `DefaultAzureCredential` + `BlobServiceClient(new Uri(...), new DefaultAzureCredential())` with the managed identity holding `Storage Blob Data Contributor` or `Storage Blob Data Reader`. Account keys bypass Azure RBAC entirely and grant full storage-account access if leaked.
- **`IOptions<T>` binding and secret redaction in logs.** When `IOptions<DatabaseOptions>` or similar binds a config section that contains a password or key, confirm that the type does not implement `ToString()` in a way that dumps field values, and that no `LogDebug` or `LogInformation` call passes the options object (or its properties) as a structured parameter. `_logger.LogInformation("Connecting with {@opts}", _options.Value)` serializes the entire object — including `Password` — into the structured log sink.

## Red flags

| Signal | Why it matters |
|--------|----------------|
| `"Password=s3cr3t;"` in `appsettings.json` or `appsettings.Development.json` | Committed to git history permanently; rotation is necessary but does not remove the historical exposure. Rotate immediately and move to Key Vault. |
| `"ClientSecret": "abc123..."` in any `appsettings*.json` | An Entra ID / OAuth client secret in config is a credential leak — any developer with repo access or any log aggregator that captures config can impersonate the app's service principal. |
| `Server=…;User Id=…;Password=…` connection string literal in source or config | Full database credentials exposed; if the connection string appears in logs (e.g., via a caught `SqlException`), the password is in the log sink. Move to managed identity + `Authentication=Active Directory Managed Identity` in the connection string. |
| `new ClientSecretCredential(tenantId, clientId, config["AzureAd:ClientSecret"])` in `Program.cs` | Using a secret to authenticate to Azure — this defeats the purpose of Key Vault if the secret is in config, and defeats managed identity. Switch to `DefaultAzureCredential`. |
| Key Vault secret named `ConnectionStrings:DefaultConnection` (with `:`) | Colons are invalid in Key Vault secret names; the provider never resolves this secret, so the app silently falls back to a lower-priority provider (possibly a committed literal). Rename to `ConnectionStrings--DefaultConnection`. |
| Key Vault access policy grants instead of RBAC roles (`Key Vault Secrets User`) | Access policies are coarser-grained than RBAC, cannot be scoped below the vault level, and are not auditable via Azure Policy. Migrate to the RBAC authorization model. |
| `AccountKey` or `SharedAccessSignature` in App Service app settings | App settings are visible in the Azure Portal to anyone with `Contributor` on the App Service resource, and may appear in deployment logs. Replace with managed identity + `BlobServiceClient(..., new DefaultAzureCredential())`. |
| `builder.Configuration.AddUserSecrets<Program>()` called without `if (builder.Environment.IsDevelopment())` guard | User secrets are a dev-only mechanism; calling them unconditionally means they are active in production where the secrets file may be present on the host, bypassing Key Vault. |
| `_logger.LogInformation($"Connecting: {connectionString}")` | Interpolated log line bakes the full connection string (with password) into the log message. Structural log sinks serialize it as a raw string; redaction is impossible after the fact. |
| `Key Vault Contributor` role assigned to a managed identity | `Contributor` is a resource-plane role — it controls vault configuration, not secret reads — but it enables reconfiguring the vault's access model, making it a privilege-escalation vector. |

## Example

See [`examples/secrets-config-audit/`](../../examples/secrets-config-audit/).

## Related skills

- [dotnet-security-review](../dotnet-security-review/SKILL.md) — use for a full security review beyond secret handling (injection, crypto, deserialization).
- [azure-hardening-review](../azure-hardening-review/SKILL.md) — use to review Key Vault configuration, RBAC roles, and managed identity posture in Azure infrastructure.
