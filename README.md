# Secure .NET on Azure Skills — Aegis

Twelve judgment skills that keep a coding agent sharp on **production-grade, secure .NET on Azure** work. Not a shallow checklist and not a rigid script — each skill guides the agent through a concrete, ASP.NET Core / Azure–specific review lens spanning security, design, performance, concurrency, and observability, naming real types, attributes, APIs, and configuration keys so every finding comes with a precise, actionable fix.

## Why

Most "security checklists" stop at "validate input" and "use strong crypto." They are language-agnostic, surface-level, and do nothing to sharpen an agent's judgment about the .NET ecosystem — `IPasswordHasher<T>` vs `MD5`, `FromSqlInterpolated` vs `FromSqlRaw`, `DefaultAzureCredential` vs a committed `ClientSecret`. These skills fill that gap: each one was reviewed for .NET / Azure specificity and ships a worked example that shows the before (the real problem pattern) and the after (the precise fix).

## Skills

### Security & secrets

| Skill | Use when… |
|-------|-----------|
| [dotnet-security-review](skills/dotnet-security-review/SKILL.md) | Reviewing a .NET / ASP.NET Core service, pull request, or diff for security issues — authorization gaps, injection, insecure crypto, secret leakage, unsafe deserialization — before merge or deploy. |
| [threat-model-endpoint](skills/threat-model-endpoint/SKILL.md) | Threat-modeling an API endpoint, feature, or data flow in an ASP.NET Core app — to enumerate STRIDE threats and concrete mitigations before building or shipping. |
| [secrets-config-audit](skills/secrets-config-audit/SKILL.md) | Auditing a .NET app for secret handling and configuration safety — hardcoded secrets, secrets in source or appsettings, Azure Key Vault wiring, and managed-identity usage. |
| [azure-hardening-review](skills/azure-hardening-review/SKILL.md) | Reviewing Azure infrastructure (Bicep, Terraform, ARM, or App Service / Container Apps config) for hardening — least-privilege identity, network exposure, Key Vault, encryption, and TLS. |
| [auth-flow-review](skills/auth-flow-review/SKILL.md) | Reviewing authentication and authorization in an ASP.NET Core app — JWT / OIDC / Entra ID configuration, token validation, and scope/role enforcement. |
| [dependency-supplychain-check](skills/dependency-supplychain-check/SKILL.md) | Reviewing a .NET project's NuGet dependencies for known vulnerabilities, abandoned packages, supply-chain hygiene, and version pinning hygiene — before merging a dependency change or during a periodic security audit. |

### Design

| Skill | Use when… |
|-------|-----------|
| [design-dotnet-feature](skills/design-dotnet-feature/SKILL.md) | Designing a new backend feature in a .NET app — to shape boundaries, layering (Clean Architecture / CQRS), validation, and error handling before writing code. |
| [solid-review](skills/solid-review/SKILL.md) | Reviewing C# / .NET code for SOLID design adherence — single responsibility, open/closed, Liskov, interface segregation, dependency inversion — to surface coupling and concrete refactor opportunities. |

### Performance & concurrency

| Skill | Use when… |
|-------|-----------|
| [dotnet-performance-review](skills/dotnet-performance-review/SKILL.md) | Reviewing .NET code for performance — allocations and GC pressure, async/IO misuse, hot-path LINQ, repeated enumeration, string handling, caching, and serialization. |
| [async-concurrency-review](skills/async-concurrency-review/SKILL.md) | Reviewing asynchronous and concurrent .NET code — async/await correctness, deadlocks, cancellation propagation, and thread safety of shared state. |
| [ef-core-review](skills/ef-core-review/SKILL.md) | Reviewing Entity Framework Core usage — for performance (N+1, tracking, projections), correctness (transactions, concurrency), and security (raw-SQL injection, migrations). |

### Observability

| Skill | Use when… |
|-------|-----------|
| [observability-review](skills/observability-review/SKILL.md) | Reviewing logging, tracing, and metrics in a .NET app — structured logging, OpenTelemetry, correlation, and avoiding PII / secret leakage in telemetry. |

## Install

### Claude Code

```
/plugin marketplace add tunahanaliozturk/secure-dotnet-skills
/plugin install secure-dotnet-skills@secure-dotnet-skills
```

### Codex

Clone the repo and copy the skill folders you want into Codex's skills directory:

```bash
git clone https://github.com/tunahanaliozturk/secure-dotnet-skills.git
cp -r secure-dotnet-skills/skills/dotnet-security-review ~/.codex/skills/
# repeat for each skill you want
```

### Cursor

Clone the repo and import the `SKILL.md` files as project rules. In Cursor, open **Settings → Rules for AI** and paste the contents of `skills/<name>/SKILL.md` — or use the `.cursor/rules/` directory in your project root for per-project rules:

```bash
git clone https://github.com/tunahanaliozturk/secure-dotnet-skills.git
mkdir -p .cursor/rules
cp secure-dotnet-skills/skills/dotnet-security-review/SKILL.md .cursor/rules/dotnet-security-review.md
# repeat for each skill you want
```

### Gemini CLI

Clone the repo and copy the skill folders you want into Gemini's skills directory:

```bash
git clone https://github.com/tunahanaliozturk/secure-dotnet-skills.git
cp -r secure-dotnet-skills/skills/dotnet-security-review ~/.gemini/skills/
# repeat for each skill you want
```

The `SKILL.md` files are the open-standard source: they are plain markdown with a YAML frontmatter `description` (the trigger) and a structured body. Any tool that supports skill/rule injection can consume them directly.

## Philosophy

- **Judgment-preserving.** Each skill guides how to think, not what to conclude. Steps are numbered process, not rigid scripts. The agent retains discretion on severity, context, and trade-offs.
- **Composable.** Install only what your project needs. A library project needs `dotnet-security-review` and `solid-review`; a greenfield Azure service benefits from all twelve. Skills do not depend on each other.
- **Depth over breadth.** Every check names a concrete .NET type, attribute, or configuration key. Generic advice is a defect, not a feature.

## Severity convention

Review skills use a four-level rating: **Critical** = exploitable security issue or data-loss risk; **High** = incorrect or fragile behavior that will cause failures; **Medium** = maintainability or performance risk; **Low** = polish and defense-in-depth.

## Contributing

Each skill must stay .NET / Azure-specific and concrete — generic advice is the main failure mode. New skills and changes must pass the `skill-reviewer` agent check and ship a worked example under `examples/<name>/README.md`. Scope is ASP.NET Core / .NET / Azure; other stacks are out of scope.

## License

MIT — see [LICENSE](LICENSE).
