# Example: dependency-supplychain-check

A worked audit of an ASP.NET Core web API solution that has a transitive vulnerability flagged by `dotnet list package --vulnerable`, a floating wildcard version, and no lock file or package source mapping.

---

## BEFORE — project with supply-chain problems

### `Directory.Packages.props` (Central Package Management partially adopted)

```xml
<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  </PropertyGroup>
  <ItemGroup>
    <!-- PROBLEM 1: floating wildcard — resolves to whatever latest is at restore time -->
    <PackageVersion Include="Newtonsoft.Json"    Version="*" />
    <PackageVersion Include="Serilog.AspNetCore" Version="8.*" />

    <!-- These are pinned, but the transitive graph is not locked -->
    <PackageVersion Include="Microsoft.EntityFrameworkCore.SqlServer" Version="8.0.4" />
    <PackageVersion Include="Azure.Identity"                          Version="1.11.3" />
    <PackageVersion Include="Swashbuckle.AspNetCore"                  Version="6.5.0" />
  </ItemGroup>
</Project>
```

### `nuget.config` (private feed, no source mapping)

```xml
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <add key="nuget.org"        value="https://api.nuget.org/v3/index.json" />
    <!-- PROBLEM 2: private feed listed with no <packageSourceMapping> —
         any MyCompany.* package can be hijacked on nuget.org           -->
    <add key="my-azure-artifacts" value="https://pkgs.dev.azure.com/contoso/feed/v3/index.json" />
  </packageSources>
  <!-- No <trustedSigners>, no <packageSourceMapping> -->
</configuration>
```

### `MyApi.csproj` (no lock file in use)

```xml
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <!-- PROBLEM 3: RestoreLockedMode not set; packages.lock.json not committed -->
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" />
    <PackageReference Include="Serilog.AspNetCore" />
    <PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" />
    <PackageReference Include="Azure.Identity" />
    <PackageReference Include="Swashbuckle.AspNetCore" />
    <!-- Internal package resolved via private feed — no source mapping protects it -->
    <PackageReference Include="MyCompany.Core" Version="2.3.1" />
  </ItemGroup>
</Project>
```

---

## Running the audit

### Step 1 — vulnerability scan (transitive)

```
> dotnet list package --vulnerable --include-transitive

The following sources were used:
   https://api.nuget.org/v3/index.json

Project `MyApi`
[net8.0]:
   Top-level Package            Requested   Resolved
   > Azure.Identity             1.11.3      1.11.3

   Transitive Package                           Resolved   Severity   Advisory URL
   > System.Text.Json                           8.0.0      High       https://github.com/advisories/GHSA-8g4q-xg66-9fp4
   > Microsoft.IdentityModel.Tokens             6.34.0     High       https://github.com/advisories/GHSA-59j7-ghrg-fj52
```

**Findings:**
- `System.Text.Json 8.0.0` — High severity CVE, pulled in transitively by `Microsoft.EntityFrameworkCore.SqlServer 8.0.4`. Fix: upgrade the direct dependency to `8.0.6+` which pulls in `System.Text.Json 8.0.4` (patched).
- `Microsoft.IdentityModel.Tokens 6.34.0` — High severity CVE, pulled in transitively by `Azure.Identity 1.11.3`. Fix: upgrade `Azure.Identity` to `1.12.0+` which targets the patched token library.

### Step 2 — deprecated packages

```
> dotnet list package --deprecated

Project `MyApi`
[net8.0]:
   Top-level Package            Requested   Resolved   Reason(s)           Alternative
   > Swashbuckle.AspNetCore     6.5.0       6.5.0      Legacy              Microsoft.AspNetCore.OpenApi
```

**Finding:** `Swashbuckle.AspNetCore 6.5.0` is marked Legacy by the publisher. The .NET 9+ recommended replacement is the built-in `Microsoft.AspNetCore.OpenApi`. For .NET 8, pin to `6.9.0` (still maintained) or plan migration.

### Step 3 — floating versions identified

Manual inspection of `Directory.Packages.props` reveals:
- `Newtonsoft.Json Version="*"` — resolves to whatever the latest is; currently `13.0.3` but could change.
- `Serilog.AspNetCore Version="8.*"` — resolves to the latest `8.x` minor/patch, which is also non-reproducible.

---

## AFTER — remediated project

### `Directory.Packages.props` — all versions pinned

```xml
<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  </PropertyGroup>
  <ItemGroup>
    <!-- FIX 1: all versions pinned to exact releases -->
    <PackageVersion Include="Newtonsoft.Json"                         Version="13.0.3" />
    <PackageVersion Include="Serilog.AspNetCore"                      Version="8.0.3" />

    <!-- FIX 2: upgraded to pull in patched transitive packages -->
    <PackageVersion Include="Microsoft.EntityFrameworkCore.SqlServer" Version="8.0.6" />
    <PackageVersion Include="Azure.Identity"                          Version="1.12.0" />

    <!-- Swashbuckle pinned to latest maintained 6.x while migration is planned -->
    <PackageVersion Include="Swashbuckle.AspNetCore"                  Version="6.9.0" />
  </ItemGroup>
</Project>
```

### `Directory.Build.props` — lock file + NuGet audit enforced

```xml
<Project>
  <PropertyGroup>
    <!-- FIX 3: lock the full resolved graph in CI -->
    <RestoreLockedMode Condition="'$(CI)' == 'true'">true</RestoreLockedMode>

    <!-- FIX 4: dotnet restore itself fails on High/Critical advisories -->
    <NuGetAudit>true</NuGetAudit>
    <NuGetAuditLevel>high</NuGetAuditLevel>
    <NuGetAuditMode>all</NuGetAuditMode>
  </PropertyGroup>
</Project>
```

Generate the lock file locally (once, then commit):

```bash
dotnet restore --use-lock-file
git add packages.lock.json
git commit -m "chore: add NuGet lock file"
```

CI restore command:

```bash
dotnet restore --locked-mode
```

If the lock file is stale (e.g. after a legitimate version bump) regenerate it locally with `dotnet restore --use-lock-file --force-evaluate`, review the diff, commit, and re-run CI.

### `nuget.config` — source mapping added

```xml
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <add key="nuget.org"          value="https://api.nuget.org/v3/index.json" />
    <add key="my-azure-artifacts" value="https://pkgs.dev.azure.com/contoso/feed/v3/index.json" />
  </packageSources>

  <!-- FIX 5: package source mapping — private prefixes resolve only from the private feed -->
  <packageSourceMapping>
    <packageSource key="nuget.org">
      <!-- nuget.org supplies everything except our internal packages -->
      <package pattern="*" />
    </packageSource>
    <packageSource key="my-azure-artifacts">
      <!-- MyCompany.* and Internal.* can ONLY come from the private feed -->
      <package pattern="MyCompany.*" />
      <package pattern="Internal.*" />
    </packageSource>
  </packageSourceMapping>
</configuration>
```

With this mapping in place, if an attacker publishes `MyCompany.Core` to nuget.org at version `99.0.0`, NuGet ignores it entirely for that prefix — it will only resolve `MyCompany.*` from `my-azure-artifacts`.

---

## Summary of findings and fixes

| # | Finding | Severity | Fix |
|---|---------|----------|-----|
| 1 | `System.Text.Json 8.0.0` transitive CVE (High) | **High** | Upgrade `Microsoft.EntityFrameworkCore.SqlServer` to `8.0.6` |
| 2 | `Microsoft.IdentityModel.Tokens 6.34.0` transitive CVE (High) | **High** | Upgrade `Azure.Identity` to `1.12.0` |
| 3 | `Swashbuckle.AspNetCore 6.5.0` deprecated (Legacy) | Medium | Pin to `6.9.0`; plan migration to `Microsoft.AspNetCore.OpenApi` |
| 4 | `Newtonsoft.Json Version="*"` floating | High | Pin to `13.0.3` in `Directory.Packages.props` |
| 5 | `Serilog.AspNetCore Version="8.*"` floating | High | Pin to `8.0.3` in `Directory.Packages.props` |
| 6 | `packages.lock.json` absent; no `RestoreLockedMode` | High | Run `dotnet restore --use-lock-file`, commit lock file, add `--locked-mode` to CI restore |
| 7 | No `<packageSourceMapping>` with private feed present | High | Add source mapping in `nuget.config` routing `MyCompany.*` / `Internal.*` exclusively to the private feed |
