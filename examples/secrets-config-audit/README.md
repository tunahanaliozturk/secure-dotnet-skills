# Example: secrets-config-audit

A worked audit of an ASP.NET Core app that stores a Postgres connection string and an Entra ID client secret in `appsettings.json`, then remediates both by moving them to Azure Key Vault and switching to managed identity.

---

## BEFORE — secrets in config

### `appsettings.json`

```json
{
  "ConnectionStrings": {
    "DefaultConnection": "Host=prod-db.postgres.database.azure.com;Database=retaildb;Username=appuser;Password=S3cr3tP@ssw0rd!"
  },
  "AzureAd": {
    "TenantId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "ClientId":  "yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy",
    "ClientSecret": "~AbCdEfGhIjKlMnOpQrStUvWxYz012345678"
  },
  "KeyVault": {
    "VaultUri": "https://my-vault.vault.azure.net/"
  }
}
```

**Problems:**

1. `Password=S3cr3tP@ssw0rd!` — the Postgres password is committed to git. Anyone with repo access, or any tool that dumps config on startup, has the production database credential.
2. `ClientSecret` — the Entra ID client secret is also committed. If the secret leaks, an attacker can authenticate as the application's service principal.
3. There is no `AddAzureKeyVault` call in `Program.cs`, so Key Vault is referenced by URI but never consulted.

### `Program.cs` (before)

```csharp
var builder = WebApplication.CreateBuilder(args);

// No Key Vault provider wired — secrets stay in appsettings.json.

builder.Services.AddNpgsqlDataSource(
    builder.Configuration.GetConnectionString("DefaultConnection")!); // password in plain text

// Authenticate to Azure using a client secret stored in config — anti-pattern.
var tenantId     = builder.Configuration["AzureAd:TenantId"]!;
var clientId     = builder.Configuration["AzureAd:ClientId"]!;
var clientSecret = builder.Configuration["AzureAd:ClientSecret"]!;

var credential = new ClientSecretCredential(tenantId, clientId, clientSecret);

builder.Services.AddSingleton<BlobServiceClient>(
    new BlobServiceClient(new Uri("https://mystorage.blob.core.windows.net/"), credential));
```

---

## Findings

| # | Config key | Severity | Finding |
|---|------------|----------|---------|
| 1 | `ConnectionStrings:DefaultConnection` | **Critical** | Postgres password committed in `appsettings.json`; present in git history after removal. Rotate immediately. |
| 2 | `AzureAd:ClientSecret` | **Critical** | Entra ID client secret committed; attacker can authenticate as the app's service principal. |
| 3 | `Program.cs` — `ClientSecretCredential` | **High** | Credential material sourced from config to authenticate to Azure; defeats managed identity and Key Vault purpose. |
| 4 | No `AddAzureKeyVault` in `Program.cs` | **High** | Key Vault URI is configured but the provider is never registered; secrets are never read from the vault. |

---

## AFTER — Key Vault + managed identity

### Key Vault secrets to create

Create these secrets in the Azure Key Vault (`https://my-vault.vault.azure.net/`).  
Note the `:`→`--` naming: colons are invalid in Key Vault secret names; the configuration provider maps `--` back to `:` at read time.

| Key Vault secret name | Value |
|-----------------------|-------|
| `ConnectionStrings--DefaultConnection` | `Host=prod-db.postgres.database.azure.com;Database=retaildb;Username=appuser;Password=S3cr3tP@ssw0rd!` |
| `AzureAd--ClientSecret` | *(rotate and store the new value — then remove the need for it entirely by using managed identity instead; see step 3 below)* |

### `appsettings.json` (after)

```json
{
  "ConnectionStrings": {},
  "AzureAd": {
    "TenantId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "ClientId":  "yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy"
  },
  "KeyVault": {
    "VaultUri": "https://my-vault.vault.azure.net/"
  }
}
```

The vault URI is not a secret — it identifies where secrets live, not the secrets themselves.  
`ConnectionStrings:DefaultConnection` and `AzureAd:ClientSecret` are gone from this file.

### `Program.cs` (after)

```csharp
var builder = WebApplication.CreateBuilder(args);

// 1. Wire Azure Key Vault as a configuration provider.
//    DefaultAzureCredential resolves to the App Service managed identity in production
//    and to VisualStudioCredential / AzureCliCredential during local development —
//    no credential material in config or code.
var vaultUri = new Uri(builder.Configuration["KeyVault:VaultUri"]!);
builder.Configuration.AddAzureKeyVault(vaultUri, new DefaultAzureCredential());

// 2. At this point, builder.Configuration["ConnectionStrings:DefaultConnection"]
//    resolves from Key Vault secret "ConnectionStrings--DefaultConnection".
//    The password never touches appsettings.json or environment variables.
builder.Services.AddNpgsqlDataSource(
    builder.Configuration.GetConnectionString("DefaultConnection")!);

// 3. For Azure service calls, use DefaultAzureCredential directly —
//    no ClientSecret required. Grant the managed identity
//    "Storage Blob Data Contributor" on the storage account via RBAC.
builder.Services.AddSingleton<BlobServiceClient>(
    new BlobServiceClient(
        new Uri("https://mystorage.blob.core.windows.net/"),
        new DefaultAzureCredential()));   // managed identity; no secret
```

### Azure RBAC grants required

| Principal | Resource | Role |
|-----------|----------|------|
| App Service managed identity | Key Vault (`my-vault`) | `Key Vault Secrets User` |
| App Service managed identity | Storage account (`mystorage`) | `Storage Blob Data Contributor` |

Do **not** grant `Key Vault Contributor` to the managed identity — that is a resource-plane role (controls vault configuration), not a data-plane role (reads secrets). `Key Vault Secrets User` is the minimum required for reading secrets.

### `IOptions<T>` logging guard

If you bind the connection string section to a typed options class, ensure it is never passed as a structured log parameter:

```csharp
// WRONG — serializes Password into the log sink
_logger.LogInformation("DB options: {@opts}", _dbOptions.Value);

// RIGHT — log only non-sensitive fields
_logger.LogInformation("Connecting to host {Host} database {Database}",
    _dbOptions.Value.Host, _dbOptions.Value.Database);
```

### Local development

`AddAzureKeyVault` runs in all environments, including local. For developers who have the Azure CLI authenticated (`az login`) or a Visual Studio account with read access to the vault, `DefaultAzureCredential` resolves automatically. Alternatively, use `dotnet user-secrets` for local overrides that do not hit the vault:

```bash
dotnet user-secrets set "ConnectionStrings:DefaultConnection" \
  "Host=localhost;Database=retaildb_dev;Username=dev;Password=localpassword"
```

`AddUserSecrets<Program>()` must be guarded so it does not run in production:

```csharp
if (builder.Environment.IsDevelopment())
    builder.Configuration.AddUserSecrets<Program>();
```
