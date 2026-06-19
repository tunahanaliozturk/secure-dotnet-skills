# Example: azure-hardening-review

A worked hardening audit of a Bicep template that deploys a storage account and an App Service web app with several common misconfigurations, then remediates each finding.

---

## BEFORE — insecure Bicep template

```bicep
// storage.bicep — insecure defaults
resource storage 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: 'myappstorage'
  location: resourceGroup().location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: true          // ❌ any container marked "blob" is public
    minimumTlsVersion: 'TLS1_0'         // ❌ deprecated TLS version
    // allowSharedKeyAccess omitted      // ❌ defaults to true — SAS/account keys work
    supportsHttpsTrafficOnly: true
    networkAcls: {
      defaultAction: 'Allow'            // ❌ no firewall; public internet can reach data plane
      bypass: 'AzureServices'
    }
  }
}

// webapp.bicep — insecure App Service
resource appServicePlan 'Microsoft.Web/serverfarms@2022-09-01' = {
  name: 'myapp-plan'
  location: resourceGroup().location
  sku: { name: 'B2', tier: 'Basic' }
}

resource webApp 'Microsoft.Web/sites@2022-09-01' = {
  name: 'myapp-web'
  location: resourceGroup().location
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: false                    // ❌ plain HTTP accepted
    siteConfig: {
      ftpsState: 'AllAllowed'          // ❌ FTP (unencrypted) and FTPS both allowed
      minTlsVersion: '1.0'            // ❌ TLS 1.0 accepted
      appSettings: [
        {
          name: 'StorageAccountKey'
          value: 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789+ABCDE='  // ❌ secret in app settings
        }
        {
          name: 'SqlConnectionString'
          value: 'Server=prod-sql.database.windows.net;Database=mydb;User Id=sqladmin;Password=P@ssw0rd!'  // ❌ credentials in plain text
        }
      ]
    }
  }
  // ❌ no managed identity — app must use keys/passwords to call Azure services
}

// ❌ No diagnostic settings on either resource
// ❌ No Microsoft Defender plans configured
```

**Problems in this template:**

1. `allowBlobPublicAccess: true` — any blob container a developer marks as `blob` or `container` access is anonymously readable on the public internet.
2. `minimumTlsVersion: 'TLS1_0'` — allows deprecated TLS versions vulnerable to BEAST and POODLE.
3. `allowSharedKeyAccess` omitted (defaults `true`) — SAS tokens and account keys work; no forced Azure AD / managed-identity authentication.
4. `networkAcls.defaultAction: 'Allow'` — storage data plane is reachable from anywhere; no virtual network or IP restriction.
5. `httpsOnly: false` — App Service accepts plain HTTP; tokens and session cookies are transmissible in cleartext.
6. `ftpsState: 'AllAllowed'` — unencrypted FTP is permitted.
7. `minTlsVersion: '1.0'` in `siteConfig` — TLS 1.0 accepted on the web app endpoint.
8. `StorageAccountKey` and `SqlConnectionString` in app settings as plain values — visible in the Azure Portal to anyone with `Contributor` on the App Service; may appear in deployment logs.
9. No `identity` block — the app has no managed identity, so it is forced to use keys and passwords.
10. No diagnostic settings, no Defender plans.

---

## Findings

| # | Resource | Severity | Finding |
|---|----------|----------|---------|
| 1 | Storage — `allowBlobPublicAccess` | **High** | Set to `true`; any container marked public is anonymously readable. Set to `false`. |
| 2 | Storage — `networkAcls.defaultAction` | **High** | `'Allow'` exposes the data plane to the public internet with no firewall. Set to `'Deny'` and add private endpoint or VNET service endpoint. |
| 3 | Storage — `allowSharedKeyAccess` | **High** | Omitted (defaults `true`); SAS tokens and account keys bypass Azure RBAC. Set to `false` and confirm the app uses `DefaultAzureCredential` + `BlobServiceClient`. |
| 4 | App Service — secrets in app settings | **High** | `StorageAccountKey` and `SqlConnectionString` are plain-text secrets; replace with Key Vault references and use managed identity for the storage connection. |
| 5 | App Service — no managed identity | **High** | No `identity` block; app cannot use `DefaultAzureCredential`; forced to use credential material. Add `identity: { type: 'SystemAssigned' }` and grant appropriate RBAC roles. |
| 6 | App Service — `httpsOnly: false` | **Medium** | Plain HTTP accepted; replace with `httpsOnly: true`. |
| 7 | App Service — `ftpsState: 'AllAllowed'` | **Medium** | Unencrypted FTP permitted; set to `'Disabled'`. |
| 8 | Storage — `minimumTlsVersion: 'TLS1_0'` | **Medium** | Deprecated TLS; set to `'TLS1_2'`. |
| 9 | App Service — `minTlsVersion: '1.0'` | **Medium** | Deprecated TLS on the web endpoint; set to `'1.2'`. |
| 10 | Both resources — no diagnostic settings | **Medium** | No audit logs flow to a workspace; incident response is impossible without access logs. Add `Microsoft.Insights/diagnosticSettings` child resources. |
| 11 | Subscription — no Defender plans | **Low** | Defender for Storage and Defender for App Service are not enabled; anomaly detection and malware scanning are absent. Enable via `Microsoft.Security/pricings`. |

---

## AFTER — hardened Bicep template

```bicep
// storage.bicep — hardened
resource storage 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: 'myappstorage'
  location: resourceGroup().location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: false             // ✅ no anonymous blob access
    minimumTlsVersion: 'TLS1_2'             // ✅ TLS 1.2 minimum
    allowSharedKeyAccess: false             // ✅ forces Azure AD / managed-identity auth; SAS/account keys rejected
    supportsHttpsTrafficOnly: true
    networkAcls: {
      defaultAction: 'Deny'                 // ✅ deny all by default
      bypass: 'AzureServices'
      // Add virtualNetworkRules or privateEndpoint in production
    }
  }
}

// Storage diagnostic settings — audit logs to Log Analytics
resource storageDiag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'storage-diag'
  scope: storage
  properties: {
    workspaceId: logAnalyticsWorkspace.id
    metrics: [{ category: 'Transaction'; enabled: true }]
    // Blob sub-resource diagnostics must be set separately on
    // Microsoft.Storage/storageAccounts/blobServices
  }
}

// webapp.bicep — hardened App Service
resource webApp 'Microsoft.Web/sites@2022-09-01' = {
  name: 'myapp-web'
  location: resourceGroup().location
  identity: {
    type: 'SystemAssigned'                  // ✅ managed identity; no credential material needed
  }
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true                         // ✅ HTTP redirected to HTTPS
    siteConfig: {
      ftpsState: 'Disabled'                // ✅ FTP and FTPS both disabled
      minTlsVersion: '1.2'                // ✅ TLS 1.2 minimum on the web endpoint
      appSettings: [
        {
          name: 'StorageAccountUri'
          value: 'https://myappstorage.blob.core.windows.net/'  // ✅ endpoint only; no key
          // App uses DefaultAzureCredential + BlobServiceClient(uri, new DefaultAzureCredential())
        }
        {
          name: 'SqlConnectionString'
          // ✅ Key Vault reference — resolved at runtime by the App Service platform;
          //    never stored as a plain value in app settings
          value: '@Microsoft.KeyVault(VaultName=my-vault;SecretName=SqlConnectionString)'
        }
      ]
    }
  }
}

// RBAC: grant the web app's managed identity the minimum required roles
resource storageBlobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, webApp.id, 'Storage Blob Data Contributor')
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      'ba92f5b4-2d11-453d-a403-e96b0029c9fe'  // Storage Blob Data Contributor
    )
    principalId: webApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource kvSecretsRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, webApp.id, 'Key Vault Secrets User')
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '4633458b-17de-408a-b874-0445c86b69e6'  // Key Vault Secrets User
    )
    principalId: webApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// Key Vault — RBAC authorization, purge protection, soft delete
resource keyVault 'Microsoft.KeyVault/vaults@2023-02-01' = {
  name: 'my-vault'
  location: resourceGroup().location
  properties: {
    sku: { family: 'A'; name: 'standard' }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true           // ✅ RBAC model; access policies disabled
    enableSoftDelete: true
    softDeleteRetentionInDays: 90           // ✅ 90-day recovery window
    enablePurgeProtection: true             // ✅ vault and secrets cannot be permanently deleted
    publicNetworkAccess: 'Disabled'         // ✅ Key Vault only reachable via private endpoint
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'AzureServices'
    }
  }
}

// App Service diagnostic settings
resource webAppDiag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'webapp-diag'
  scope: webApp
  properties: {
    workspaceId: logAnalyticsWorkspace.id
    logs: [
      { category: 'AppServiceHTTPLogs';      enabled: true }
      { category: 'AppServiceAuditLogs';     enabled: true }
      { category: 'AppServiceConsoleLogs';   enabled: true }
    ]
    metrics: [{ category: 'AllMetrics'; enabled: true }]
  }
}

// Microsoft Defender for Cloud — Storage and App Service plans
resource defenderStorage 'Microsoft.Security/pricings@2023-01-01' = {
  name: 'StorageAccounts'
  properties: { pricingTier: 'Standard' }  // ✅ includes malware scanning and anomaly detection
}

resource defenderAppService 'Microsoft.Security/pricings@2023-01-01' = {
  name: 'AppServices'
  properties: { pricingTier: 'Standard' }
}
```

### .NET app — storage client (no key needed)

```csharp
// With allowSharedKeyAccess: false on the storage account,
// the SDK must use a token credential. DefaultAzureCredential resolves
// to the App Service system-assigned managed identity in production
// and to AzureCliCredential / VisualStudioCredential locally.
builder.Services.AddSingleton<BlobServiceClient>(_ =>
    new BlobServiceClient(
        new Uri(builder.Configuration["StorageAccountUri"]!),
        new DefaultAzureCredential()));
```

### Prioritized hardening checklist

**High — fix before any production deployment**
- [ ] Set `allowBlobPublicAccess: false` on all storage accounts.
- [ ] Set `allowSharedKeyAccess: false` and confirm the .NET app uses `DefaultAzureCredential`.
- [ ] Set `networkAcls.defaultAction: 'Deny'` on storage and Key Vault; add private endpoints or VNET rules.
- [ ] Replace every literal secret in App Service app settings with `@Microsoft.KeyVault(...)` references.
- [ ] Add `identity: { type: 'SystemAssigned' }` to all App Service / Container Apps resources and grant scoped RBAC roles.

**Medium — fix in the current sprint**
- [ ] Set `httpsOnly: true` on all `Microsoft.Web/sites`.
- [ ] Set `ftpsState: 'Disabled'` in `siteConfig`.
- [ ] Set `minimumTlsVersion: 'TLS1_2'` on storage; `minTlsVersion: '1.2'` in App Service `siteConfig`.
- [ ] Add `Microsoft.Insights/diagnosticSettings` child resources to every data resource, routing to a Log Analytics workspace.
- [ ] Enable `enableRbacAuthorization: true` and `enablePurgeProtection: true` on Key Vault.

**Low — harden in the next cycle**
- [ ] Enable Microsoft Defender for Cloud Standard tier for `StorageAccounts`, `AppServices`, `KeyVaults`, and `SqlServers`.
- [ ] Extend soft-delete retention on Key Vault to 90 days.
- [ ] Audit all `Microsoft.Authorization/roleAssignments` for `Owner`/`Contributor` on app identities; downscope to data-plane roles.
