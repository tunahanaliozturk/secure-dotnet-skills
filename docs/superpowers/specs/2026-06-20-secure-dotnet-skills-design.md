# Secure .NET on Azure — Agent Skills Collection — Design

**Date:** 2026-06-20
**Status:** Approved

## Purpose

A focused, multi-tool collection of judgment/process **agent skills** that keep a
coding agent sharp on **secure .NET on Azure** work: security review, threat
modeling, secret/config auditing, Azure hardening, auth review, feature design,
EF Core review, and dependency/supply-chain checking.

The differentiator is depth and quality, not breadth. Most "agent skills" repos
are shallow link lists. Each skill here is opinionated, ASP.NET Core / Azure
specific (not generic advice), composable, and validated before publishing.

## Audience and tools

Skills follow the open `SKILL.md` standard, so they are consumable by Claude Code,
OpenAI Codex, Cursor, and Gemini CLI. The canonical content is one
`skills/<name>/SKILL.md` per skill; tool-specific manifests point at the same
folders.

## Naming

Repository: `secure-dotnet-skills` (discoverable). Brand subtitle: **Aegis**.

## Repository structure

```
secure-dotnet-skills/
├── README.md                       # menu, install, philosophy
├── LICENSE                         # MIT
├── skills/
│   ├── dotnet-security-review/SKILL.md
│   ├── threat-model-endpoint/SKILL.md
│   ├── secrets-config-audit/SKILL.md
│   ├── azure-hardening-review/SKILL.md
│   ├── design-dotnet-feature/SKILL.md
│   ├── auth-flow-review/SKILL.md
│   ├── ef-core-review/SKILL.md
│   └── dependency-supplychain-check/SKILL.md
├── .claude-plugin/
│   ├── plugin.json                 # Claude Code plugin manifest
│   └── marketplace.json            # `/plugin marketplace add <user>/secure-dotnet-skills`
├── .codex-plugin/                  # Codex-compatible manifest
└── examples/                       # one worked example per skill
```

The `skills/<name>/SKILL.md` folder is the single source of truth. Cursor and
Gemini consume the same files; the `.claude-plugin` and `.codex-plugin` manifests
only reference them.

## Skill anatomy (the quality bar)

Every `SKILL.md` contains:

1. **Frontmatter** — `name` and a `description` that states *when* the skill
   triggers, in concrete phrasing (so the agent loads it at the right moment).
2. **Process** — numbered steps that guide judgment without becoming a rigid
   script; the agent keeps room to think.
3. **.NET / Azure–specific checks** — concrete, not generic. Examples of the
   kind of specificity required: `[Authorize]` vs `[AllowAnonymous]` coverage,
   antiforgery, `IDataProtector` / Data Protection key ring, EF Core
   parameterization and N+1, `IHttpClientFactory`, `DefaultAzureCredential` /
   managed identity, `Microsoft.Identity.Web` token validation, Bicep
   least-privilege role assignments, TLS/min-version, private endpoints.
4. **Red flags table** — a short, scannable list of warning signals.
5. **A worked example** in `examples/<skill>/` — a real finding or before/after.

**Why this is "better":** each skill is reviewed by the `skill-reviewer` agent
before publishing and carries a documented eval scenario (a trigger phrase plus
the expected behavior). This is the moat over shallow lists.

## The eight skills (v1)

1. **dotnet-security-review** — review a .NET service or diff for security issues
   (authorization, injection, crypto, secret leakage, OWASP) with ASP.NET Core
   lenses. The flagship.
2. **threat-model-endpoint** — STRIDE-based threat model of an API endpoint or
   feature, adapted to ASP.NET Core, with concrete mitigations.
3. **secrets-config-audit** — find hardcoded secrets; validate Key Vault / config
   wiring and managed-identity usage. (Natural tie-in to the user's KeyVaultSync.)
4. **azure-hardening-review** — review Bicep / Terraform / App Service config for
   least privilege, networking, identity, Key Vault, and TLS.
5. **design-dotnet-feature** — guide designing a backend feature with Clean
   Architecture / CQRS: boundaries, validation, error model.
6. **auth-flow-review** — review authentication/authorization (JWT, OIDC, Entra
   ID, scopes/roles) for ASP.NET Core.
7. **ef-core-review** — review EF Core usage for performance, correctness, and
   security: raw-SQL injection, N+1, migration risks.
8. **dependency-supplychain-check** — review NuGet dependencies for known
   vulnerabilities, abandonment, and supply-chain risk.

## Distribution / install (lean)

- **Claude Code:** `/plugin marketplace add <user>/secure-dotnet-skills`, then the
  skills are available.
- **Codex / Cursor / Gemini:** clone the repo and copy `skills/` into the tool's
  skills directory; the README gives a one-line command per tool.
- No custom installer CLI in v1 (an `npx` interactive installer is a v2 option).

## Build process

Same subagent-driven flow used for prior projects:
- Task 1: scaffold repo (structure, manifests, README skeleton, LICENSE).
- Tasks 2–9: one skill per task. Each skill is authored, then reviewed by the
  `skill-reviewer` agent (the markdown analogue of the code-review gate); each
  ships with its worked example and eval scenario.
- Final task: README polish (menu, install, philosophy) and a whole-collection
  consistency review.

Quality gate per skill = `skill-reviewer` approval + a worked example + a
documented eval scenario, in place of code tests.

## Out of scope (YAGNI)

- An `npx` interactive installer (v2).
- Languages/stacks beyond .NET/C# and Azure.
- An automated eval-runner harness (eval scenarios are documented, not executed
  by CI in v1).
- A VS Code extension.
- Additional skills beyond the eight (e.g. logging/observability, rate-limiting)
  — candidates for v2.

## Success criteria

- Eight skills, each passing `skill-reviewer` and carrying a worked example.
- Installable in Claude Code via marketplace; consumable by Codex/Cursor/Gemini
  from the same `SKILL.md` files.
- README that makes the value and install path obvious in under a minute.
