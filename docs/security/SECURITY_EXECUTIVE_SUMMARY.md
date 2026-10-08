# Security assessment — 8 October 2026

Reviewed backend, frontend, Word, AI/tool authorization, MCP/OAuth, database/storage source, dependencies and GitHub CI settings. Starting revision: 1c53d65fb17c688396a48aea0e21ec29fbdc5941. Dedicated branch: security/comprehensive-hardening. No push, merge, deployment or history rewrite performed.

Three Medium application weaknesses fixed with failing-before/passing-after regressions: MCP GET response byte admission, sensitive central console errors, Office archive expansion. No new Critical or High application vulnerability established in examined paths; this is not proof of absence.

Eight findings: three Fixed, five Open, none Accepted. Open: two upstream High dependency advisories, unprotected main, mutable CI action tags, custom MCP trust classification. Four separate live-verification items remain Not Verified. See SECURITY_FINDINGS.md for prerequisites, evidence and residual risk.

Full npm audit: 0 Critical, 19 High development-tool package findings, 0 Moderate, 0 Low. Production-only: zero in all four independent lockfile trees. The 19 findings represent two advisories, not 19 established application exploits. Dependencies/locks unchanged; no suppressions or unverified crypto patches. See DEPENDENCY_SECURITY.md.

Backend 2769 passed / 62 skipped; frontend 1679 passed; Word server 3 passed. Pinned security suite 1525 passed / 16 skipped (overlaps broader suites). All final executed checks passed. Builds and applicable type checks passed; frontend lint retains 31 warnings. See SECURITY_TEST_RESULTS.md.

Production readiness remains conditional on live identity/MFA, RLS, buckets, restore/deletion, browser/Office workflows and provider privacy verification. Main lacks effective protection: establish mandatory reviews/checks before relying on CI gates. SECURITY.md reporting contact remains an owner setup item. New archive ceilings intentionally reject oversized content and add decompression work; no permission redesign or schema changes.

Local-first must not imply all legal data remains on the Mac: configured database/object storage, selected AI providers, enabled connectors and telemetry cross separate boundaries. See PRIVACY_DATA_FLOW.md and THREAT_MODEL.md. Synthetic data only; no new dependencies, browser binaries, services or Docker installed.

Priorities: protect main, track official dependency fixes, further isolate parser CPU/RSS, verify live cloud/Office/browser controls, decide MCP trust and provider retention policy. No unresolved risk accepted on the owner's behalf. ATTACK_SURFACE_INVENTORY.md records route evidence and review scope.

## Primary-category scorecard

Each finding assigned once. Not Verified counts are four verification work items, not confirmed vulnerabilities; a zero does not certify exhaustive coverage.

| Category | Findings | Fixed | Open | Not Verified |
| --- | ---: | ---: | ---: | ---: |
| Authentication | 0 | 0 | 0 | 1 |
| Authorization | 0 | 0 | 0 | 0 |
| Document security | 1 | 1 | 0 | 0 |
| Frontend | 0 | 0 | 0 | 0 |
| Backend APIs | 0 | 0 | 0 | 0 |
| AI / Prompt injection | 1 | 0 | 1 | 0 |
| MCP / OAuth | 1 | 1 | 0 | 0 |
| Word add-in | 0 | 0 | 0 | 1 |
| Database / Storage | 0 | 0 | 0 | 1 |
| Dependencies | 2 | 0 | 2 | 0 |
| CI/CD | 2 | 0 | 2 | 0 |
| Privacy | 1 | 1 | 0 | 1 |

Verified code/test commit: 28be6f29922ad3b474db60284815f18a261471b2.
