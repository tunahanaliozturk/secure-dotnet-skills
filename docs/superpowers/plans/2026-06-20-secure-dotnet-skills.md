# Secure .NET on Azure — Agent Skills Collection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a multi-tool collection of eight high-quality, judgment-style agent skills for secure .NET on Azure work, packaged as a Claude Code plugin and consumable from the open `SKILL.md` standard by Codex/Cursor/Gemini.

**Architecture:** Each skill is a `skills/<name>/SKILL.md` folder (the cross-tool source of truth) plus a worked example in `examples/<name>/`. A `.claude-plugin/` manifest exposes them to Claude Code. There is no code and no build step — the deliverables are markdown skills; the quality gate is the `skill-reviewer` agent (+ `plugin-validator` for manifests), the markdown analogue of tests.

**Tech Stack:** Markdown `SKILL.md` (open standard), Claude Code plugin manifest (JSON), MIT license. No runtime/build.

## Global Constraints

- This is the `secure-dotnet-skills` repository (already `git init`'d). All paths are relative to its root. Author/owner: **Tunahan Ali Ozturk**, GitHub `tunahanaliozturk`, repo URL `https://github.com/tunahanaliozturk/secure-dotnet-skills`.
- Skills are **judgment/process** skills (keep the agent sharp), not rigid scripts and not code generators. Steps guide thinking; they must not over-constrain.
- Every skill must be **ASP.NET Core / .NET / Azure specific and concrete** — name real types, attributes, APIs, and config keys. Generic "validate input / use strong crypto" advice is a defect; the checks listed per task are the minimum specificity bar.
- Scope is **secure .NET on Azure**. Do not add other languages/stacks.
- Quality gate per skill (replaces tests): the `skill-reviewer` agent approves it, AND it ships a worked example under `examples/<name>/`, AND its frontmatter `description` states concrete trigger conditions.
- Tone/format: match the house `SKILL.md` style — short imperative prose, numbered process, scannable tables. No marketing fluff inside SKILL.md.

### Skill authoring contract (every skill task implicitly includes this)

Each `skills/<name>/SKILL.md` MUST have exactly this structure:

```markdown
---
name: <name>
description: <one sentence starting with "Use when …" naming concrete triggers>
---

# <Human Title>

<1–2 sentence statement of what this skill makes the agent do.>

## When to use

<2–4 bullets: the situations that should trigger this skill.>

## Process

1. <step>
2. <step>
…  (numbered, judgment-preserving; 4–7 steps)

## .NET / Azure checks

<bulleted, concrete checklist — the items named in the task below, expanded
into clear review prompts. Each item references a real type/attribute/API/config.>

## Red flags

| Signal | Why it matters |
|--------|----------------|
| <concrete code/config smell> | <the risk> |
| …(5–10 rows) | |

## Example

See [`examples/<name>/`](../../examples/<name>/).
```

The worked example `examples/<name>/README.md` MUST show a concrete *before* (a
short realistic .NET/Azure snippet with the problem) and an *after*/findings
(what the skill surfaces and the fix). Keep snippets short and illustrative.

---

### Task 1: Scaffold (structure, plugin manifests, README skeleton, LICENSE)

**Files:**
- Create: `LICENSE` (MIT)
- Create: `.claude-plugin/plugin.json`
- Create: `.claude-plugin/marketplace.json`
- Create: `README.md` (skeleton — final content in Task 10)
- Create: `skills/.gitkeep`, `examples/.gitkeep`

**Interfaces:**
- Produces: the repo skeleton later tasks drop skills into; `plugin.json` `skills` field points at `./skills/`.

- [ ] **Step 1: Create the MIT `LICENSE`**

Create `LICENSE` with the standard MIT License text, copyright line: `Copyright (c) 2026 Tunahan Ali Ozturk`.

- [ ] **Step 2: Create `.claude-plugin/plugin.json`**

```json
{
  "name": "secure-dotnet-skills",
  "displayName": "Secure .NET on Azure Skills (Aegis)",
  "description": "Judgment skills that keep a coding agent sharp on secure .NET on Azure: security review, threat modeling, secret/config audit, Azure hardening, auth review, feature design, EF Core review, and dependency checks.",
  "author": { "name": "Tunahan Ali Ozturk", "url": "https://github.com/tunahanaliozturk" },
  "homepage": "https://github.com/tunahanaliozturk/secure-dotnet-skills",
  "repository": "https://github.com/tunahanaliozturk/secure-dotnet-skills",
  "license": "MIT",
  "keywords": ["dotnet", "csharp", "aspnetcore", "azure", "security", "appsec", "skills", "agent"],
  "skills": "./skills/"
}
```

- [ ] **Step 3: Create `.claude-plugin/marketplace.json`**

```json
{
  "name": "secure-dotnet-skills",
  "owner": { "name": "Tunahan Ali Ozturk", "url": "https://github.com/tunahanaliozturk" },
  "plugins": [
    {
      "name": "secure-dotnet-skills",
      "source": "./",
      "description": "Judgment skills for secure .NET on Azure: review, threat modeling, secrets/config audit, Azure hardening, auth, feature design, EF Core, and dependency checks.",
      "version": "0.1.0",
      "license": "MIT",
      "keywords": ["dotnet", "azure", "security", "appsec", "skills"]
    }
  ]
}
```

- [ ] **Step 4: Create README skeleton**

Create `README.md`:
```markdown
# Secure .NET on Azure Skills — Aegis

Judgment skills that keep a coding agent sharp on **secure .NET on Azure** work.
Not a giant framework and not shallow advice — eight focused, ASP.NET Core /
Azure–specific skills for review, threat modeling, and design.

> Skills are filled in by the implementation plan. See `skills/`.

## Install

(Filled in Task 10.)

## Skills

(Filled in Task 10.)

## License

MIT
```

- [ ] **Step 5: Add directory keepers**

Create empty files `skills/.gitkeep` and `examples/.gitkeep`.

- [ ] **Step 6: Validate manifests**

Validate the plugin/marketplace manifests against the current Claude Code plugin schema (use the `plugin-validator` agent or `plugin-dev:plugin-structure` knowledge). Fix any schema errors it reports (field names, required fields). The `skills` field must point to `./skills/`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold repo, plugin manifests, README skeleton, MIT license"
```

---

### Task 2: Skill — dotnet-security-review (flagship)

**Files:**
- Create: `skills/dotnet-security-review/SKILL.md`
- Create: `examples/dotnet-security-review/README.md`

Follow the **Skill authoring contract**. Content:

- **Frontmatter `description`:** `Use when reviewing a .NET / ASP.NET Core service, pull request, or diff for security issues — authorization gaps, injection, insecure crypto, secret leakage, unsafe deserialization — before merge or deploy.`
- **Process:** (1) scope the change and identify trust boundaries (external inputs, auth surface, outbound calls); (2) confirm default-deny authorization; (3) walk the checks lens by lens; (4) rate each finding by severity and exploitability; (5) give a concrete fix per finding with the .NET API to use; (6) re-scan for the same class elsewhere.
- **.NET / Azure checks (must include, concrete):**
  - `[Authorize]` / `[AllowAnonymous]` coverage; sensitive endpoints not anonymous; a default-deny fallback policy.
  - Broken object-level authorization / IDOR: does the handler verify the caller owns the requested resource id?
  - Overposting / mass assignment: binding straight to EF entities vs request DTOs; `[Bind]`/`[FromBody]` shape.
  - SQL injection: `FromSqlRaw`/`ExecuteSqlRaw` with interpolated/concatenated strings → `FromSqlInterpolated` or parameters.
  - Unsafe deserialization: `BinaryFormatter`, `NetDataContractSerializer`, `TypeNameHandling.All` in Json.NET.
  - Crypto: `MD5`/`SHA1` for security, hardcoded keys/IVs, custom crypto → use `Microsoft.AspNetCore.DataProtection` / ASP.NET Core Identity hashing.
  - Secret leakage: secrets in `appsettings*.json`, source, or logs; tokens/PII written to logs.
  - Transport/outbound: disabled TLS validation (`ServerCertificateCustomValidationCallback => true`), SSRF on user-controlled outbound URLs.
  - CORS: `AllowAnyOrigin()` combined with credentials; over-broad policies.
  - Antiforgery for cookie-authenticated state-changing requests; missing security headers; verbose exception detail in production.
- **Red flags (seed rows, expand to 6–10):** `FromSqlRaw($"…")`; `AllowAnyOrigin()` + `AllowCredentials()`; `BinaryFormatter`; `ServerCertificateCustomValidationCallback = (_,_,_,_) => true`; `[AllowAnonymous]` on a write endpoint; connection string literal in `appsettings.json`; `TypeNameHandling.All`.
- **Example (`examples/dotnet-security-review/README.md`):** a short controller with (a) IDOR (returns any user's order by id without ownership check) and (b) `FromSqlRaw` string concat; show the findings (severity + why) and the fixed code (ownership check + parameterized query).

**Verification:** dispatched `skill-reviewer` agent approves; description triggers are concrete; every check names a real .NET API; example present.

- [ ] **Step 1: Write `skills/dotnet-security-review/SKILL.md`** per the contract and content above.
- [ ] **Step 2: Write `examples/dotnet-security-review/README.md`** (before/after as described).
- [ ] **Step 3: Self-review** — frontmatter valid; 6–10 red-flag rows; checks are ASP.NET Core-specific; example compiles conceptually.
- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add dotnet-security-review skill"
```

---

### Task 3: Skill — threat-model-endpoint

**Files:**
- Create: `skills/threat-model-endpoint/SKILL.md`
- Create: `examples/threat-model-endpoint/README.md`

Follow the contract. Content:

- **`description`:** `Use when threat-modeling an API endpoint, feature, or data flow in an ASP.NET Core app — to enumerate STRIDE threats and concrete mitigations before building or shipping.`
- **Process:** (1) name the asset/data flow, the actors, and the trust boundaries it crosses; (2) walk STRIDE in order; (3) for each category list the concrete threats for this endpoint; (4) rank by likelihood × impact; (5) for each threat note the mitigation and whether it is present or missing; (6) output a short threat table.
- **.NET / Azure checks, organized by STRIDE (must include):**
  - **Spoofing:** authentication scheme; JWT issuer/audience/lifetime/signing validation; Entra ID via `Microsoft.Identity.Web`.
  - **Tampering:** model validation; signed/encrypted tokens; integrity of stored data; optimistic concurrency.
  - **Repudiation:** audit logging with correlation/trace ids; immutable logs.
  - **Information disclosure:** over-returning fields (entity vs DTO); error/exception detail (`ProblemDetails` without internals); PII/secrets in logs.
  - **Denial of service:** rate limiting (`builder.Services.AddRateLimiter`), request body size limits, timeouts, async I/O, pagination.
  - **Elevation of privilege:** authorization policies, scope (`scp`)/role (`roles`) checks, least-privilege managed identity.
- **Red flags:** no authorization policy beyond `[Authorize]`; returns EF entities directly; no rate limiting on expensive/anonymous endpoints; `ValidateAudience = false`; unbounded request body; detailed errors in prod.
- **Example:** a STRIDE table for a `POST /transfers` (funds transfer) endpoint — each STRIDE row with threat, present/missing mitigation, and the .NET mechanism.

- [ ] **Step 1: Write the SKILL.md.**
- [ ] **Step 2: Write the example.**
- [ ] **Step 3: Self-review** (STRIDE complete; each category has .NET specifics; example table present).
- [ ] **Step 4: Commit** — `feat: add threat-model-endpoint skill`

---

### Task 4: Skill — secrets-config-audit

**Files:**
- Create: `skills/secrets-config-audit/SKILL.md`
- Create: `examples/secrets-config-audit/README.md`

Follow the contract. Content:

- **`description`:** `Use when auditing a .NET app for secret handling and configuration safety — hardcoded secrets, secrets in source or appsettings, Azure Key Vault wiring, and managed-identity usage.`
- **Process:** (1) scan source and `appsettings*.json` for literal secrets; (2) map the config layering (appsettings → environment → user-secrets → Key Vault) and where each secret should live; (3) verify Key Vault integration and its authentication; (4) confirm logging never emits secrets; (5) give a remediation path per finding.
- **.NET / Azure checks (must include):**
  - Literal connection strings, API keys, passwords, tokens, SAS in source or `appsettings*.json`.
  - Config provider order; secrets in committed `appsettings.json` vs `dotnet user-secrets` (dev only) vs environment vs Key Vault.
  - Azure Key Vault configuration provider (`AddAzureKeyVault`) usage.
  - `DefaultAzureCredential` / managed identity vs a client secret stored in config (anti-pattern).
  - Key Vault secret naming for nested config (`:` → `--`) — cross-reference the user's KeyVaultSync tool.
  - RBAC (`Key Vault Secrets User/Officer`) vs legacy access policies; SAS/account keys vs RBAC for storage.
  - `IOptions<T>` binding that doesn't log secrets; no secret values in `ILogger` calls or exception messages; no secrets in CI logs / `dotnet --info` style dumps.
- **Red flags:** `"Password=…"` in `appsettings.json`; `ClientSecret` in config; `Server=…;User Id=…;Password=…` literals; secrets echoed in logs; access policies instead of RBAC on Key Vault.
- **Example:** an `appsettings.json` with a Postgres connection string and a client secret → remediation: move to Key Vault, switch to `DefaultAzureCredential`/managed identity, reference via `KeyVault:VaultUri`.

- [ ] **Step 1: Write SKILL.md.**
- [ ] **Step 2: Write example.**
- [ ] **Step 3: Self-review.**
- [ ] **Step 4: Commit** — `feat: add secrets-config-audit skill`

---

### Task 5: Skill — azure-hardening-review

**Files:**
- Create: `skills/azure-hardening-review/SKILL.md`
- Create: `examples/azure-hardening-review/README.md`

Follow the contract. Content:

- **`description`:** `Use when reviewing Azure infrastructure (Bicep, Terraform, ARM, or App Service / Container Apps config) for hardening — least-privilege identity, network exposure, Key Vault, encryption, and TLS.`
- **Process:** (1) inventory the resources and their identities; (2) check identity & RBAC for least privilege; (3) check network exposure; (4) check data protection (Key Vault, encryption, TLS); (5) check logging/diagnostics; (6) output a prioritized hardening list (high/medium/low).
- **Azure checks (must include):**
  - System-assigned managed identity over secrets; no over-scoped role assignments (no `Owner`/`Contributor` at subscription for app identities).
  - Public network access disabled / private endpoints; NSG and firewall rules; no `0.0.0.0/0`.
  - Key Vault: RBAC authorization, purge protection + soft delete, no broad access policies.
  - Storage: `allowBlobPublicAccess: false`, `minimumTlsVersion: TLS1_2`, `allowSharedKeyAccess: false`, HTTPS only.
  - App Service / Container Apps: `httpsOnly: true`, FTPS disabled, min TLS 1.2, secrets via Key Vault references not plain app settings.
  - Diagnostic settings to Log Analytics; Microsoft Defender for Cloud enabled where relevant.
- **Red flags:** `publicNetworkAccess: 'Enabled'` on data resources; `allowBlobPublicAccess: true`; role assignment `Owner`/`Contributor` to an app identity; client secrets in app settings; `minimumTlsVersion` unset or `TLS1_0`.
- **Example:** a Bicep snippet (storage account + web app) with public blob access, shared-key access, and a secret in app settings → hardened diff.

- [ ] **Step 1: Write SKILL.md.**
- [ ] **Step 2: Write example.**
- [ ] **Step 3: Self-review.**
- [ ] **Step 4: Commit** — `feat: add azure-hardening-review skill`

---

### Task 6: Skill — design-dotnet-feature

**Files:**
- Create: `skills/design-dotnet-feature/SKILL.md`
- Create: `examples/design-dotnet-feature/README.md`

Follow the contract. Content:

- **`description`:** `Use when designing a new backend feature in a .NET app — to shape boundaries, layering (Clean Architecture / CQRS), validation, and error handling before writing code.`
- **Process:** (1) clarify the use case, inputs, and invariants; (2) choose the boundaries (domain / application / infrastructure) and whether it's a command or a query; (3) define the contracts (request/response DTOs); (4) choose a validation strategy; (5) choose an error model (expected vs exceptional); (6) note cross-cutting concerns (auth, logging, idempotency); (7) list the slices to build, in order.
- **.NET specifics (must include):**
  - Vertical slice or MediatR `IRequest`/handler per command/query; keep handlers thin.
  - Validation: FluentValidation or DataAnnotations; where it runs (pipeline behavior vs controller).
  - Error model: `Result<T>` for expected failures vs exceptions for truly exceptional; map to `ProblemDetails` at the API edge.
  - EF Core aggregate/transaction boundary aligned to the command.
  - Idempotency for unsafe operations (idempotency key, dedupe).
  - DI registration and testing seams (interfaces for external dependencies).
- **Red flags:** business logic in controllers; anemic handlers that leak EF entities to the API; throwing exceptions for ordinary validation failures; no idempotency on money/state-changing operations.
- **Example:** design a "redeem license key" feature — command + handler + DTOs + validation + error model + the build slices.

- [ ] **Step 1: Write SKILL.md.**
- [ ] **Step 2: Write example.**
- [ ] **Step 3: Self-review.**
- [ ] **Step 4: Commit** — `feat: add design-dotnet-feature skill`

---

### Task 7: Skill — auth-flow-review

**Files:**
- Create: `skills/auth-flow-review/SKILL.md`
- Create: `examples/auth-flow-review/README.md`

Follow the contract. Content:

- **`description`:** `Use when reviewing authentication and authorization in an ASP.NET Core app — JWT / OIDC / Entra ID configuration, token validation, and scope/role enforcement.`
- **Process:** (1) identify the auth scheme(s) and where they're configured; (2) verify token validation parameters; (3) check authorization policies and their enforcement; (4) hunt for gaps (anonymous exposure, missing default-deny); (5) check token lifetime/refresh and cookie flags; (6) output findings with fixes.
- **.NET checks (must include):**
  - `AddAuthentication().AddJwtBearer`: `ValidateIssuer`, `ValidateAudience`, `ValidateLifetime`, `ValidateIssuerSigningKey` all true; HTTPS authority/metadata.
  - Entra ID via `Microsoft.Identity.Web` (`AddMicrosoftIdentityWebApi`); correct audience/scopes.
  - Authorization policies: scope (`scp`) and app-role (`roles`) checks; `[Authorize(Policy=…)]` not bare `[Authorize]` for fine-grained access.
  - Fallback policy = `RequireAuthenticatedUser` (default-deny); no sensitive `[AllowAnonymous]`.
  - No `ValidateLifetime = false`; sane `ClockSkew`; refresh-token storage/rotation.
  - Cookie auth: `HttpOnly`, `Secure`, `SameSite`; correct sign-out.
- **Red flags:** `ValidateAudience = false`; `ValidateIssuerSigningKey = false`; `RequireHttpsMetadata = false` in production; bare `[Authorize]` guarding admin actions; long-lived tokens with no refresh; `SameSite=None` without `Secure`.
- **Example:** a `JwtBearer` setup with `ValidateAudience = false` and admin endpoints guarded only by `[Authorize]` → findings + corrected configuration and policy.

- [ ] **Step 1: Write SKILL.md.**
- [ ] **Step 2: Write example.**
- [ ] **Step 3: Self-review.**
- [ ] **Step 4: Commit** — `feat: add auth-flow-review skill`

---

### Task 8: Skill — ef-core-review

**Files:**
- Create: `skills/ef-core-review/SKILL.md`
- Create: `examples/ef-core-review/README.md`

Follow the contract. Content:

- **`description`:** `Use when reviewing Entity Framework Core usage — for performance (N+1, tracking, projections), correctness (transactions, concurrency), and security (raw-SQL injection, migrations).`
- **Process:** (1) find the query hotspots and write paths; (2) check the loading strategy; (3) check write/transaction correctness; (4) check raw-SQL safety; (5) check migrations for data-loss and idempotency; (6) output findings with fixes.
- **EF Core checks (must include):**
  - N+1 from lazy loading or missing `Include`; eager vs explicit loading.
  - `AsNoTracking()` for read-only queries; projecting to DTOs vs materializing full entities.
  - Raw SQL: `FromSqlRaw`/`ExecuteSqlRaw` with interpolation → `FromSqlInterpolated`/parameters.
  - Client-side evaluation forced by unsupported expressions.
  - `SaveChanges` inside loops; batch with one `SaveChanges`.
  - Concurrency tokens (`[Timestamp]` / `IsRowVersion`); transactions for multi-entity writes.
  - Migrations: destructive column drops/renames and data loss; idempotent scripts; `EnableRetryOnFailure` for transient faults; connection pooling / `DbContext` lifetime.
- **Red flags:** `FromSqlRaw($"… {userInput}")`; query in a `foreach` issuing per-row DB calls; `.ToList()` then filtering in memory; `SaveChanges()` per iteration; entity returned to controller; migration dropping a column without a data plan.
- **Example:** a repository with an N+1 loop and a `FromSqlRaw` string-concat search → fixed with `Include`/projection and `FromSqlInterpolated`.

- [ ] **Step 1: Write SKILL.md.**
- [ ] **Step 2: Write example.**
- [ ] **Step 3: Self-review.**
- [ ] **Step 4: Commit** — `feat: add ef-core-review skill`

---

### Task 9: Skill — dependency-supplychain-check

**Files:**
- Create: `skills/dependency-supplychain-check/SKILL.md`
- Create: `examples/dependency-supplychain-check/README.md`

Follow the contract. Content:

- **`description`:** `Use when reviewing a .NET project's NuGet dependencies for known vulnerabilities, abandoned packages, and supply-chain risk.`
- **Process:** (1) enumerate direct and transitive dependencies; (2) check for known vulnerabilities; (3) check maintenance health; (4) check supply-chain hygiene; (5) output a prioritized remediation list.
- **.NET checks (must include):**
  - `dotnet list package --vulnerable --include-transitive`; `dotnet list package --deprecated`; `--outdated` for staleness.
  - Central Package Management (`Directory.Packages.props`) and pinned versions; no floating `*` versions.
  - Lock files (`packages.lock.json`) + `--locked-mode` (or `RestoreLockedMode`) in CI.
  - Package source mapping in `nuget.config` to prevent dependency-confusion; trusted feeds only; avoid unofficial mirrors.
  - Signed-package validation; review large transitive trees and abandoned packages (no recent releases/commits); license compatibility.
- **Red flags:** floating version ranges; no lock file; a single `nuget.config` source without source mapping when private feeds exist; a vulnerable transitive package flagged by `--vulnerable`; a key dependency unmaintained for years.
- **Example:** a project whose `--vulnerable --include-transitive` flags a transitive package, plus a floating version → remediation (pin/upgrade, add lock file + locked-mode, add source mapping).

- [ ] **Step 1: Write SKILL.md.**
- [ ] **Step 2: Write example.**
- [ ] **Step 3: Self-review.**
- [ ] **Step 4: Commit** — `feat: add dependency-supplychain-check skill`

---

### Task 10: README, install docs, and whole-collection consistency

**Files:**
- Modify: `README.md` (replace skeleton with full content)
- Review: all eight `skills/*/SKILL.md` for consistency

**Interfaces:**
- Consumes: all eight skills from Tasks 2–9.

- [ ] **Step 1: Write the full `README.md`**

Replace `README.md` with content covering, in this order:
1. Title + one-paragraph pitch (depth over breadth; secure .NET on Azure judgment skills).
2. **Why** — the gap it fills (shallow lists vs reviewed, .NET-specific depth).
3. **Skills** — a table of all 8: name (link to its SKILL.md), one-line "use when" trigger.
4. **Install**:
   - Claude Code: ```/plugin marketplace add tunahanaliozturk/secure-dotnet-skills``` then ```/plugin install secure-dotnet-skills@secure-dotnet-skills```.
   - Codex / Cursor / Gemini CLI: clone the repo and copy `skills/<name>/` into the tool's skills directory (give the concrete path/command for each: Codex `~/.codex/skills/`, Cursor project `.cursor/`-style rules import, Gemini `~/.gemini/` skills) — state that the `SKILL.md` files are the open-standard source consumed by all of them.
5. **Philosophy** — judgment-preserving, composable, install only what you need.
6. **Contributing** — each skill must stay .NET/Azure-specific and pass `skill-reviewer`.
7. License: MIT.

- [ ] **Step 2: Consistency pass**

Read all eight `SKILL.md` files and verify: identical section ordering per the authoring contract; every `description` starts with "Use when"; every skill has a Red flags table and an Example link that resolves; no skill drifted into generic advice. Fix inconsistencies inline.

- [ ] **Step 3: Verify example links resolve**

Confirm each `skills/<name>/SKILL.md` "Example" link points to an existing `examples/<name>/README.md`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: full README, install docs, and consistency pass"
```

---

## Notes for the implementer

- There are no code tests. Per-skill quality is gated by the `skill-reviewer` agent (run by the controller as the task review) plus the self-review checklist in each task. The scaffold's manifests are gated by `plugin-validator`.
- The single deviation from the spec: the spec listed a `.codex-plugin/` manifest. Because the Codex skills manifest format could not be verified, v1 ships the Claude Code `.claude-plugin/` manifest plus README copy-in instructions for Codex/Cursor/Gemini — the `SKILL.md` files themselves are the cross-tool open standard. A `.codex-plugin/` manifest can be added in v2 once its format is confirmed.
- Keep every skill concrete and .NET/Azure-specific; generic advice is the main failure mode to avoid.
