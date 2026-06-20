---
name: dependency-supplychain-check
description: Use when reviewing a .NET project's NuGet dependencies for known vulnerabilities, abandoned packages, supply-chain hygiene, and version pinning hygiene — before merging a dependency change or during a periodic security audit.
---

# Dependency & Supply-Chain Check

Directs the agent to enumerate every NuGet dependency (direct and transitive), surface known CVEs, flag supply-chain risks (floating versions, missing lock files, unguarded package sources), and produce a prioritized remediation list with the exact commands and config changes required.

## When to use

- A PR adds, upgrades, or removes a NuGet package in any .NET project or solution.
- A periodic security audit requires a point-in-time vulnerability sweep across the dependency graph.
- CI is failing on a `--locked-mode` restore because the lock file is out of date or absent.
- A private Azure Artifacts feed is in use alongside nuget.org and no source mapping is configured (dependency-confusion risk).

## Process

1. **Enumerate all dependencies.** Run `dotnet list package --include-transitive` on the solution or each project to capture the full dependency graph (direct + transitive). Note the SDK version and `<TargetFramework>` — some advisories are framework-specific.
2. **Check for known vulnerabilities.** Run `dotnet list package --vulnerable --include-transitive`. The CLI queries the GitHub Advisory Database (via NuGet's vulnerability metadata endpoint) and reports each vulnerable package, the affected version range, the advisory URL, and severity. Treat every High/Critical advisory as a blocker; Medium advisories require a documented risk-acceptance comment or a fix.
3. **Check maintenance health.** Run `dotnet list package --deprecated` to catch packages the NuGet gallery has marked deprecated (absorbed into another package, legacy, or has a known critical bug). Run `dotnet list package --outdated` to see how many major/minor versions behind each dependency is. Cross-reference heavily outdated packages against NuGet.org and the package's GitHub repo for commit activity — a package with no releases in 3+ years and no open-source maintainer is an abandonment risk.
4. **Check supply-chain hygiene.** Audit four areas in order: (a) version pinning — no floating `*` or open-ended `>=` version specs in `.csproj` or `Directory.Packages.props`; (b) lock file — `packages.lock.json` present and committed, `RestoreLockedMode` set in project or CI uses `--locked-mode` on `dotnet restore`; (c) package source mapping — `nuget.config` lists a `<packageSourceMapping>` section that maps every known package prefix to its authoritative feed, preventing a same-named private package from resolving from nuget.org (dependency confusion); (d) signed packages — `nuget.config` `<trustedSigners>` or the NuGet audit settings require package signing from trusted publishers for critical packages.
5. **Output a prioritized remediation list.** Group findings: **Critical/High CVEs** → must fix before merge; **Deprecated/abandoned** → fix in current sprint or log a ticket; **Floating versions / no lock file** → fix in this PR (no merge until hygiene is clean); **Source mapping gaps** → fix before next private-feed onboarding. For each finding, give the exact package name, current version, required action, and the command or config snippet to apply it.

## .NET / Azure checks

- **`dotnet list package --vulnerable --include-transitive`.** Run against every project (or pass the `.sln` file). The output shows the direct or transitive package, the version in use, and the advisory severity and URL. A transitive vulnerable package requires either upgrading the direct dependency that pulls it in, or adding an explicit `<PackageReference>` to the fixed transitive version as an override. Never ignore a High or Critical advisory without a written risk-acceptance entry in the PR description and a linked tracking issue.
- **`dotnet list package --deprecated` and `--outdated`.** Deprecated packages report the deprecation reason (Legacy, CriticalBugs, Other) and the recommended replacement. Outdated shows Current / Resolved / Latest columns — a package multiple major versions behind warrants a compatibility check before upgrading. Pay extra attention to packages owned by organisations that have changed hands or gone silent.
- **Central Package Management (`Directory.Packages.props`).** In multi-project solutions, all version numbers should live in a single `Directory.Packages.props` at the repo root and individual `.csproj` files use `<PackageReference Include="Foo" />` without a `Version` attribute. This eliminates version skew across projects and makes upgrades a single-file change. Flag any `.csproj` that still carries its own `Version` attribute when CPM is (or should be) in use.
- **No floating `*` versions.** A `<PackageVersion Include="Newtonsoft.Json" Version="*" />` or `Version="13.*"` in `Directory.Packages.props` (or a `<PackageReference Version="*" />` in a `.csproj`) resolves to whatever latest version exists at restore time, making builds non-reproducible and supply-chain attacks easier. Every version specifier must be an exact pinned version (e.g. `Version="13.0.3"`).
- **Lock files (`packages.lock.json`) and `RestoreLockedMode`.** `packages.lock.json` (generated by `dotnet restore --use-lock-file`) records the complete resolved graph including transitive dependencies and their content hashes. Commit it to source control. In CI, pass `--locked-mode` to `dotnet restore` (or set `<RestoreLockedMode>true</RestoreLockedMode>` in the project / `Directory.Build.props`) so that any graph change that was not committed triggers a build failure rather than silently pulling a different package. This is the primary control against a "floating transitive" attack.
- **Package source mapping in `nuget.config`.** When a project uses both nuget.org and a private feed (Azure Artifacts, GitHub Packages, an internal Nexus), every package must be mapped to exactly one authoritative source. Without `<packageSourceMapping>`, NuGet may resolve a private package name from nuget.org if an attacker publishes a higher-versioned package there (dependency confusion). Example of a correct `nuget.config` mapping:
  ```xml
  <packageSourceMapping>
    <packageSource key="nuget.org">
      <package pattern="*" />
    </packageSource>
    <packageSource key="my-azure-artifacts">
      <package pattern="MyCompany.*" />
      <package pattern="Internal.*" />
    </packageSource>
  </packageSourceMapping>
  ```
  Private package prefixes (`MyCompany.*`) must point exclusively at the private feed; the nuget.org catch-all `*` must not match them.
- **Signed-package validation.** For critical infrastructure packages, add `<trustedSigners>` entries in `nuget.config` to require repository or author signatures from known publishers. At minimum, enable NuGet audit mode (`<NuGetAudit>true</NuGetAudit>` / `<NuGetAuditLevel>low</NuGetAuditLevel>` in `Directory.Build.props`) so that `dotnet restore` itself surfaces advisories without a separate `dotnet list package` step, and configure it to fail the build on High/Critical (`<NuGetAuditMode>all</NuGetAuditMode>`).
- **Abandoned packages.** A package with its last NuGet release more than 2–3 years ago, an archived or deleted GitHub repository, or one listed as unmaintained in its README carries long-term risk: CVEs will not be patched, and the package may disappear from the feed. For such packages, identify an actively maintained alternative or vendor the source.
- **License compatibility.** Review the licenses of new direct dependencies (and high-risk transitive ones) for compatibility with the project's own license and enterprise policy. GPL-licensed transitive dependencies can impose copyleft obligations on a commercial product. Tools such as `dotnet-project-licenses` or NuGet Package Manager audit screens can automate this. Flag GPL, AGPL, or "non-commercial only" licenses as requiring legal review.

## Red flags

| Signal | Why it matters |
|--------|----------------|
| `dotnet list package --vulnerable --include-transitive` reports a High or Critical severity advisory | A known, exploitable CVE is present in the deployed dependency graph; the advisory URL contains PoC or exploitation context in most cases. |
| `<PackageVersion Include="SomeLib" Version="*" />` in `Directory.Packages.props` or `Version="*"` in `.csproj` | Floating versions make the build non-reproducible; a malicious publisher can push a higher version to the feed and have it silently picked up on the next restore. |
| `packages.lock.json` absent or not committed to source control | The full resolved graph is never validated; transitive dependencies can change between restores without any record or alert. |
| `dotnet restore` in CI without `--locked-mode` (and no `RestoreLockedMode` in the project) | CI pulls whatever the registry serves today; a supply-chain compromise or accidental version bump is invisible until runtime. |
| Private Azure Artifacts feed in `nuget.config` with no `<packageSourceMapping>` section | Any `MyCompany.*` package can be shadow-published to nuget.org at a higher version and will be preferred by NuGet's version resolution (dependency-confusion attack). |
| `dotnet list package --deprecated` reports a CriticalBugs deprecation reason | The NuGet gallery owner has flagged the package as having a known critical defect; the fix is the named replacement package, not a version pin. |
| A key dependency (e.g. a serializer, crypto library, or JWT library) with no NuGet release in 3+ years and an archived GitHub repo | Unmaintained packages accumulate unpatched CVEs; no patch will be forthcoming. Replace or vendor the dependency. |
| All packages resolve from `nuget.org` only — no source mapping — but the team uses an internal feed for `Internal.*` packages | Indicates source mapping was never configured; any internal package name can be hijacked on nuget.org. |

## Example

See [`examples/dependency-supplychain-check/`](../../examples/dependency-supplychain-check/).
