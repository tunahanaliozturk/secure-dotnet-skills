# Changelog

All notable changes are documented here. The format is based on Keep a Changelog and the
project adheres to Semantic Versioning.

## [0.2.0] - 2026-06-20

### Added

- Four new skills: `api-contract-review`, `resilience-review`, `rate-limiting-review`, `container-deployment-review` (16 skills total).
- Structural validator (`test/structure.test.mjs`) run via `node --test`: checks every skill's frontmatter, required sections, and example-link resolution, plus manifest version parity.
- Continuous integration (GitHub Actions): the structural validator and markdownlint on push and PRs.
- Cross-references (`## Related skills`) between overlapping skills.
- README: CI/license/version badges, a lifecycle visual, and a regrouped 16-skill table.

## [0.1.0]

### Added

- Initial release: 12 judgment skills for secure .NET on Azure (security, design, performance, concurrency, observability), each with a worked example, packaged as a Claude Code plugin.
