# secure-dotnet-skills v2 — Polish + Four New Skills — Design

**Date:** 2026-06-20
**Status:** Approved
**Builds on:** 2026-06-20-secure-dotnet-skills-design.md (v1, 12 skills)
**Release:** `0.2.0`

## Purpose

Take the published 12-skill collection (Aegis) from "shipped" to "polished and growing":

- **Phase 1 — polish:** add an automated quality gate (a structural validator + CI +
  markdownlint), cross-reference the naturally overlapping skills, enrich the README
  (badges, a lifecycle visual, a regrouped skill table), add a CHANGELOG, and bump to 0.2.0.
- **Phase 2 — four new skills:** `api-contract-review`, `resilience-review`,
  `rate-limiting-review`, `container-deployment-review` — same judgment/process style,
  ASP.NET Core / Azure–specific, each with a worked example.

The collection grows from 12 to **16 skills**.

## Current state (context)

- 12 `skills/<name>/SKILL.md` folders + 12 `examples/<name>/README.md`, a `.claude-plugin/`
  (plugin.json + marketplace.json, version `0.1.0`), a README, MIT LICENSE, and the v1
  docs. No toolchain, no CI, no CHANGELOG.
- Every skill follows the authoring contract: frontmatter (`name`, `description` starting
  "Use when"), `## When to use`, `## Process`, `## .NET / Azure checks`, `## Red flags`
  (table), `## Example` (link to `examples/<name>/`).

## Phase 1 — Polish

### 1. Structural validator + toolchain
Introduce a light Node toolchain (mirrors the BuilderIO/skills pattern and Atelier):

- `package.json` — `name: secure-dotnet-skills`, `type: module`, `private: true`,
  `engines.node >= 18`, `license: MIT`, `scripts.test: "node --test"`. No runtime deps.
- `test/structure.test.mjs` — for every folder under `skills/`, assert: frontmatter parses
  and `name` equals the folder name; `description` starts with `Use when`; the required
  sections are present in order (`## When to use`, `## Process`, `## .NET / Azure checks`,
  `## Red flags`, `## Example`); the `## Example` link resolves to an existing
  `examples/<name>/README.md`. Also assert `.claude-plugin/plugin.json` `skills` ==
  `./skills/`, and marketplace `version` == plugin `version`.
- A tiny frontmatter parser helper (`test/frontmatter.mjs`) so the test has no third-party
  dependency (parse the `---` block into `{ name, description }`).

This is the markdown-repo equivalent of unit tests: it catches a dropped section, a broken
example link, or a non-"Use when" description before publish.

### 2. CI + markdownlint
- `.github/workflows/ci.yml` — on push and pull_request: run `node --test` (Node 20.x), and
  run markdownlint via `DavidAnson/markdownlint-cli2-action`.
- `.markdownlint-cli2.jsonc` — lenient config that disables the noisy rules for this
  content style (`MD013` line length, `MD033` inline HTML, `MD041` first-line heading —
  files lead with frontmatter, `MD024` duplicate headings — repeated section names across
  skills are fine within a file only; keep it scoped) so the lint passes on current content
  and flags real breakage, not formatting taste.

### 3. Cross-references
Add a short `## Related skills` section (after `## Example`) to the skills that genuinely
overlap, pointing to the deeper skill — the validator allows this optional trailing
section. The links:
- `ef-core-review` ↔ `dotnet-performance-review` (query perf vs broad perf).
- `secrets-config-audit` ↔ `dotnet-security-review` (secrets lens vs full review).
- `rate-limiting-review` ↔ `threat-model-endpoint` (DoS) and `api-contract-review` (429).
- `resilience-review` ↔ `dotnet-performance-review` and `async-concurrency-review`.
- `api-contract-review` ↔ `design-dotnet-feature` and `auth-flow-review`.
- `container-deployment-review` ↔ `azure-hardening-review` (Bicep/App Service vs container).

### 4. README enrichment + regrouping
- Badges: CI status, license (MIT), version (0.2.0).
- Regroup the (now 16) skills into four coherent groups in the README table:
  - **Security & secrets:** dotnet-security-review, threat-model-endpoint,
    secrets-config-audit, auth-flow-review, dependency-supplychain-check, rate-limiting-review.
  - **Design & contracts:** design-dotnet-feature, solid-review, api-contract-review.
  - **Performance, concurrency & resilience:** dotnet-performance-review,
    async-concurrency-review, ef-core-review, resilience-review.
  - **Delivery & ops:** azure-hardening-review, container-deployment-review, observability-review.
- A small mermaid visual mapping the skill groups onto a request's lifecycle (design →
  build → secure → run/observe), so a reader sees where each group applies.

### 5. Version + CHANGELOG
- Bump `version` to `0.2.0` in `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`
  (kept equal — the validator asserts it). Add `version` to `package.json` as `0.2.0`.
- Add `CHANGELOG.md` (Keep a Changelog) with `[0.2.0] - 2026-06-20`: the toolchain/CI, the
  four new skills, cross-references, and the README work; and a `[0.1.0]` line for the
  original 12-skill release.

## Phase 2 — Four new skills

Each follows the v1 authoring contract exactly (frontmatter; When to use; numbered Process;
`## .NET / Azure checks` with concrete ASP.NET Core / Azure specifics — generic advice is a
defect; a `## Red flags` table; a worked `examples/<name>/README.md` with a before/after;
and a `## Related skills` section). Detailed checklists live in the implementation plan.

- **api-contract-review** (Design & contracts) — REST/HTTP API design review: resource
  modeling, correct status codes, `ProblemDetails` errors, idempotency for unsafe verbs,
  versioning strategy, pagination, content negotiation, and OpenAPI/`Microsoft.AspNetCore.OpenApi`
  accuracy. Example: an endpoint returning `200` on failure with ad-hoc error JSON → fixed
  with correct status + `ProblemDetails` + idempotency key.

- **resilience-review** (Performance, concurrency & resilience) — transient-fault handling:
  timeouts, retries with jittered backoff, circuit breakers, bulkhead isolation, and
  fallback, via `Microsoft.Extensions.Http.Resilience` / Polly and `HttpClient` resilience
  handlers; idempotency as a retry precondition; `CancellationToken` and overall deadlines.
  Example: a bare `HttpClient` call with no timeout/retry → a resilience pipeline.

- **rate-limiting-review** (Security & secrets) — abuse and overload protection:
  `builder.Services.AddRateLimiter` with the right algorithm (fixed/sliding window, token
  bucket, concurrency), partitioning by client/identity, `429` + `Retry-After`, queueing
  limits, and where limiting belongs (gateway vs app). Example: an unprotected expensive
  anonymous endpoint → a partitioned limiter with proper 429 semantics.

- **container-deployment-review** (Delivery & ops) — containerized .NET delivery:
  multi-stage Dockerfile, non-root user, minimal/chiseled base images, correct `ASPNETCORE`
  config, health/liveness/readiness probes, resource requests/limits, secrets via the
  platform (not image layers), and image-scanning. Example: a root-running, single-stage
  Dockerfile with a baked-in secret → a hardened multi-stage build + probes.

## Architecture / units

The repo stays a flat collection of independent `SKILL.md` units plus a thin validator.
No skill depends on another at runtime; cross-references are documentation links. The
validator and CI are the only "code"; they are pure (read files, assert), no third-party
deps.

## Testing / quality gate

- `node --test` runs `test/structure.test.mjs` over all 16 skills (structure, frontmatter,
  example-link resolution, manifest version parity) — green locally and in CI.
- markdownlint (lenient) in CI.
- Each new skill is reviewed by the `skill-reviewer` agent (the same gate as v1) and ships
  a worked example.

## Out of scope (YAGNI)

- An `npx` interactive installer (still a later option).
- Executing the skills' eval scenarios in CI (structure validation only).
- Skills beyond the four above.
- Reformatting existing skills to satisfy strict markdownlint (the config is intentionally
  lenient).

## Success criteria

- 16 skills, each passing the structural validator and `skill-reviewer`, each with a worked
  example.
- `node --test` green locally and in CI (Node 20); markdownlint green.
- README shows badges, the regrouped 16-skill table, and the lifecycle visual; CHANGELOG and
  versions at `0.2.0`.
- Overlapping skills cross-reference each other.
