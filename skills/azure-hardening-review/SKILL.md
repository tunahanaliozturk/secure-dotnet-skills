---
name: azure-hardening-review
description: Use when reviewing Azure infrastructure (Bicep, Terraform, ARM, or App Service / Container Apps config) for hardening — least-privilege identity, network exposure, Key Vault, encryption, and TLS.
---

# Azure Infrastructure Hardening Review

Directs the agent to audit Azure resource definitions for the hardening gaps most commonly exploited in .NET on Azure deployments — over-privileged managed identities, public data-plane exposure, weak TLS, storage shared-key access, missing Key Vault controls, and absent diagnostic coverage — and to produce a prioritized high / medium / low remediation list with the exact Bicep properties or Azure CLI commands required.

## When to use

- Reviewing a Bicep, Terraform, or ARM template PR before it deploys to a non-development environment.
- Auditing an existing App Service, Storage account, Key Vault, or Container Apps resource against the Microsoft Cloud Security Benchmark.
- Pre-production security gate: confirming network exposure, identity, and TLS settings meet the bar before go-live.
- Post-incident hardening: validating that the misconfiguration that enabled an attack (public blob access, shared-key access, over-scoped role) has been closed.

## Process

1. **Inventory the resources and their identities.** List every resource type in scope (storage accounts, App Services, Container Apps, Key Vaults, SQL servers, Service Bus namespaces, etc.) and note which managed identity (system-assigned or user-assigned) is associated with each. Flag any resource that has no managed identity and instead relies on connection strings or access keys.
2. **Check identity and RBAC for least privilege.** For every role assignment, confirm the principal is a managed identity (not a service principal backed by a client secret), the role is the narrowest data-plane role sufficient (`Storage Blob Data Reader` not `Contributor`), and the scope is the resource or resource group — not the subscription. Flag `Owner` or `Contributor` assigned to any app-tier identity.
3. **Check network exposure.** For every data resource (storage, SQL, Service Bus, Key Vault, Container Registry), confirm `publicNetworkAccess` is `'Disabled'` or restricted to specific IP ranges / virtual network service endpoints / private endpoints. Flag any `0.0.0.0/0` inbound rule in an NSG or firewall. Verify App Service and Container Apps are not reachable on plain HTTP.
4. **Check data protection — Key Vault, encryption, and TLS.** Verify Key Vault has RBAC authorization enabled, purge protection on, and soft-delete retention of at least 7 days. For storage accounts, confirm `allowBlobPublicAccess: false`, `minimumTlsVersion: 'TLS1_2'`, `allowSharedKeyAccess: false`, and `supportsHttpsTrafficOnly: true`. For App Service, confirm `httpsOnly: true`, FTPS state `'Disabled'`, and minimum TLS 1.2 in `siteConfig`. For Container Apps, confirm ingress `transport` is not `'http'` on a public endpoint.
5. **Check logging and diagnostics.** Confirm every in-scope resource has a diagnostic setting that routes at minimum audit / access logs to a Log Analytics workspace. Confirm Microsoft Defender for Cloud is enabled on the subscription (or at least on the relevant resource types: Defender for Storage, Defender for App Service, Defender for SQL). Flag resources with no diagnostic settings.
6. **Output a prioritized hardening list.** Group findings into **High** (active attack surface: public data exposure, no private endpoint on a data resource, shared-key enabled, `Owner`/`Contributor` on app identity), **Medium** (degraded posture: TLS below 1.2, no purge protection, HTTPS not enforced, no diagnostic settings), and **Low** (defense-in-depth: no Defender plan, soft-delete retention short, FTPS not explicitly disabled). Each finding must name the Bicep property path and the corrected value.

## .NET / Azure checks

- **System-assigned managed identity — no client secrets in config.** Every App Service and Container App must have `identity: { type: 'SystemAssigned' }` (or a user-assigned identity) in Bicep. Flag any app setting named `ClientSecret`, `AccountKey`, `ConnectionString`, or `Password` — these indicate the app is authenticating to Azure services with credential material rather than managed identity. The correct pattern is `DefaultAzureCredential` in the .NET app and a scoped RBAC role assignment on the Azure resource.
- **No over-scoped role assignments.** Inspect every `Microsoft.Authorization/roleAssignments` resource. Flag any assignment where the `roleDefinitionId` resolves to `Owner` (8e3af657-…) or `Contributor` (b24988ac-…) and the principal is an application managed identity. App identities need data-plane roles only: `Storage Blob Data Reader/Contributor`, `Key Vault Secrets User`, `Service Bus Data Sender/Receiver`, `AcrPull`. Subscription-scoped assignments for app identities are always a finding.
- **`publicNetworkAccess: 'Disabled'` on data resources.** Storage accounts, Key Vaults, SQL servers, Service Bus namespaces, and Container Registries must set `publicNetworkAccess: 'Disabled'` or constrain access via `networkAcls` with `defaultAction: 'Deny'` and explicit virtual network rules or private endpoints. Flag any resource where `publicNetworkAccess` is `'Enabled'` and there is no private endpoint.
- **Storage: `allowBlobPublicAccess: false`, `minimumTlsVersion: 'TLS1_2'`, `allowSharedKeyAccess: false`, `supportsHttpsTrafficOnly: true`.** All four properties must be explicitly set in the Bicep `Microsoft.Storage/storageAccounts` properties block. `allowBlobPublicAccess: true` exposes every blob container that a developer accidentally marks public. `allowSharedKeyAccess: false` forces all clients to use Azure AD / managed identity; any SAS token or account key stops working immediately — confirm the .NET app uses `BlobServiceClient` with `DefaultAzureCredential`. `minimumTlsVersion` defaults to `'TLS1_0'` if omitted; flag omission as a finding.
- **App Service / Container Apps: `httpsOnly: true`, FTPS disabled, minimum TLS 1.2, secrets via Key Vault references.** In `Microsoft.Web/sites`, set `properties.httpsOnly: true` and `properties.siteConfig.ftpsState: 'Disabled'` and `properties.siteConfig.minTlsVersion: '1.2'`. Any app setting whose value is not a Key Vault reference (`@Microsoft.KeyVault(...)`) but contains a secret is a finding. Container Apps ingress must set `transport: 'auto'` (or `'http2'`) and `allowInsecure: false`.
- **Key Vault: RBAC authorization, purge protection, soft delete.** In `Microsoft.KeyVault/vaults`, confirm `properties.enableRbacAuthorization: true`, `properties.enablePurgeProtection: true`, and `properties.enableSoftDelete: true` with `properties.softDeleteRetentionInDays` ≥ 7. Flag any vault using access policies (`properties.accessPolicies` non-empty) — access policies cannot be scoped below the vault level, are not auditable via Azure Policy, and do not integrate with Entra ID PIM.
- **Diagnostic settings to Log Analytics.** Every resource should have a `Microsoft.Insights/diagnosticSettings` child resource that sends `allLogs: true` (or the resource's specific audit log category) and `AllMetrics` to a `workspaceId`. Flag resources with no diagnostic settings child. For storage accounts, diagnostic settings must be on the sub-resources (`blobServices`, `fileServices`) not just the account.
- **Microsoft Defender for Cloud plans.** Confirm the subscription has Defender plans enabled for the resource types in use: `Microsoft.Security/pricings` resources for `StorageAccounts`, `AppServices`, `SqlServers`, `KeyVaults`, `ContainerRegistry`. Defender for Storage specifically detects anomalous access patterns, malware (via hash reputation), and sensitive-data discovery. Flag any resource type in scope that has no corresponding Defender plan.

## Red flags

| Signal | Why it matters |
|--------|----------------|
| `publicNetworkAccess: 'Enabled'` on a storage account, Key Vault, or SQL server with no private endpoint | The data plane is reachable from the public internet; a misconfigured firewall rule or accidental `networkAcls.defaultAction: 'Allow'` exposes all data. |
| `allowBlobPublicAccess: true` on a storage account | Any container a developer marks as `blob` or `container` access becomes anonymously readable on the internet, no authentication required. |
| `allowSharedKeyAccess: true` (or property omitted) on a storage account | Shared-key access enables SAS tokens and account keys, which bypass Azure RBAC, cannot be scoped to specific identities, and are frequently leaked in config or logs. |
| `minimumTlsVersion: 'TLS1_0'` or `'TLS1_1'`, or property omitted on storage/App Service | Allows deprecated TLS versions vulnerable to BEAST and POODLE; the default if omitted is `TLS1_0`. Must be explicitly set to `'TLS1_2'`. |
| Role assignment `Owner` or `Contributor` on a managed identity at subscription or resource-group scope | Grants the app identity control-plane write access to all resources in scope — far beyond any legitimate read/write data-plane need. An attacker who compromises the app can reconfigure or delete infrastructure. |
| App setting with a literal secret value (connection string, API key, SAS token) instead of a Key Vault reference `@Microsoft.KeyVault(...)` | App settings are visible to anyone with `Contributor` on the App Service resource in the Azure Portal and may appear in deployment logs. Key Vault references are resolved at runtime by the App Service platform and never stored in the settings store. |
| Key Vault with `enableRbacAuthorization: false` (access policies) | Access policies are coarser-grained than RBAC (vault-level only, no Azure Policy audit support, no PIM integration), and grant permanent standing access without just-in-time approval. |
| Key Vault with `enablePurgeProtection: false` or no `enableSoftDelete` | Without purge protection, secrets and the vault itself can be permanently deleted — including by ransomware that compromises a privileged identity. Purge protection is required for BCDR compliance. |
| `httpsOnly: false` or property absent on `Microsoft.Web/sites` | The App Service accepts plain HTTP requests; tokens and session cookies transmitted over HTTP are trivially interceptable. |
| No `Microsoft.Insights/diagnosticSettings` child resource on a data resource | Audit logs (who accessed what, when) are not collected; incident response and compliance reporting are impossible without logs flowing to a workspace. |

## Example

See [`examples/azure-hardening-review/`](../../examples/azure-hardening-review/).

## Related skills

- [container-deployment-review](../container-deployment-review/SKILL.md) — use to review Dockerfile, runtime user, health probes, and secrets for container delivery.
- [secrets-config-audit](../secrets-config-audit/SKILL.md) — use for deeper review of Key Vault wiring and managed-identity usage in the .NET app.
