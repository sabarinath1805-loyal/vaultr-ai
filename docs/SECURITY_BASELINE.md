# Vaultr-AI security baseline

This document freezes the application contracts represented by the
`security-baseline-1` tag. It records local code and test evidence; it does
not certify a production deployment or a third-party provider. Run the pinned
suite with `npm run test:security` before changing these contracts.

## Current security contracts

### Authorization and revocation

Every new protected read, tool dispatch, external action, and write must use
current resource authority. Captured chat, workflow, document, review, memory,
upload, or job context is not continuing authority. Denied paths return a
generic result and stop before protected content, provider dispatch, or
persistence. Revocation cannot recall content already emitted or an external
operation already committed while authority was valid. A previously issued
signed upload URL is a finite bearer capability until expiry; refresh,
completion, and promotion of unaccepted upload work recheck destination
authority. Durable cleanup and account-deletion cleanup continue after user
access ends.

Evidence includes `streamingRevocation.test.ts`,
`toolDispatcher.revocation.test.ts`, `memory.curator.revocation.test.ts`,
`uploads.access.test.ts`, `uploads.processing.test.ts`, Tabular extraction
and row-revocation tests, queued export worker tests, and the signed URL and
upload-session route tests. These are local deterministic test contracts;
provider-side revocation of an already issued URL is not claimed.

### Rate limits, fairness, lockout, and store fallback

Authenticated limits key on the authenticated identity; coarse source-IP
budgets allow shared-office traffic. Failed login attempts use a normalized
identifier-plus-source-IP budget and a separate failed-only IP ceiling;
successful logins do not consume those failure budgets. Signup and reset
identifier buckets are separated by action. The `/user` and `/users` route
aliases receive equivalent protections, and route-coverage tests enumerate
registered route variants.

When Redis is unavailable, counters move to the bounded in-process store and
a rate-limited warning is logged. This fallback is not shared across API
processes. Authenticated, authentication, identifier, and cost-sensitive
classes fail closed if admission cannot be enforced, returning a sanitized
503 with `Retry-After: 30`. The coarse general IP-only backstop fails open
with a warning because the authenticated route budget remains. Expired
in-memory keys are reclaimed; active keys are never evicted to admit a new
identity; admission fails closed when the 10,000-key default bound is full.

Default request budgets:

| Class | Per-user or identifier budget | Coarse IP budget |
| --- | --- | --- |
| General | 300 / 15 min | 15,000 / 15 min |
| Chat | 30 / 15 min | 1,500 / 15 min |
| Chat creation | 60 / 15 min | 3,000 / 15 min |
| Tool result | 2,000 / 15 min | 100,000 / 15 min |
| Export | 10 / hour | 500 / hour |
| Workflow import | 50 / hour | 2,500 / hour |
| Data deletion | 20 / hour | 1,000 / hour |
| Upload-session mutation | 300 / 15 min | 15,000 / 15 min |
| Upload-session polling | 3,000 / 15 min | 150,000 / 15 min |
| Upload-session creation | 50 / hour | 2,500 / hour |
| Login failures | 10 / normalized identifier + IP / 15 min | 100 failed attempts / 15 min |
| Signup or reset | 10 / identifier + IP / hour | 100 / IP / hour |
| Auth flow | 30 / 15 min | 1,500 / 15 min |
| MFA | 20 / 15 min | 1,000 / 15 min |

The configured 50:1 backstop ratio is intended to leave room for many people
behind one office address. At defaults, 100 people making 20 chat requests
each in 15 minutes can exceed the 1,500-request shared IP cap; tune this for
the actual workload without removing per-user limits. The chat, office-peer,
failed-login, Redis fallback, real Redis, proxy, and route-coverage evidence is
in the WS5/WS5b tests and `audit.md`.

### BYO endpoints, keys, and outbound requests

Provider credentials are stored encrypted and are not returned by ordinary
status or export APIs. A saved user key is bound to its provider origin;
editing an endpoint cannot silently forward that key to a new host. Model
selection and endpoint configuration do not grant resource authority.
Public destinations require HTTPS. Private model destinations require an
operator-declared exact origin; metadata, link-local, loopback (except the
explicit local-model path), and other blocked address classes are not general
remote destinations. DNS is checked at connection time, redirects are
revalidated, response sizes and time are bounded, and errors are sanitized.
MCP and external integration calls use their guarded paths.

The backend, frontend, Word, and browser test network guards are default-on.
Tests may use loopback fakes and may not opt out to reach providers. This
protects test execution; production egress still requires host or cloud
firewall policy.

Evidence is in `configuredModels.test.ts`, `modelSelection.test.ts`,
`user.apiKeyStore.test.ts`, `outboundHttp.test.ts`, MCP SSRF/provider tests,
the egress guard tests, and the browser proxy guard. No live provider was
used.

### Capacity defaults

| Bound | Default | Scope and behavior |
| --- | ---: | --- |
| Concurrent model streams per user | 2 | Admission limit. |
| Concurrent model streams per organization | 20 | Shared organization limit. |
| Stream maximum duration | 15 min | Hard deadline. |
| Stream idle timeout | 2 min | Business-data idle deadline; heartbeats do not extend it. |
| Stream fallback leases | 10,000 keys | Process-local; reclaim expired leases, never evict active leases, refuse new admission when full. |
| Pending/running jobs | 500 per protected class | Durable database queue admission. |
| Jobs per user / organization | 100 / 200 per protected class | Durable queue admission. |
| Concurrent jobs per user | 2 | Excess jobs return to pending without spending a retry. |
| Upload processing | 2 per user; 8 global | Global concurrency hard cap is 64. |
| Upload conversion | 2 min | Child-process conversion deadline. |
| Upload job wall clock | 15 min | Worker stops renewing the lease after the bound. |
| Chat message / context | 50,000 / 200,000 characters | Request and built-context bounds. |
| Attachments / tool rounds / calls | 20 / 16 / 64 | Per chat turn. |
| Logical upload storage quota | Disabled (`0`) | Optional per-user and per-organization quotas; temporary bytes and renditions are excluded. |
| Global JSON / upload manifest body | 1 MiB / 256 KiB | Upload session manifest is parsed after admission and authentication. |

These limits bound concurrency and request shape. They do not provide a global
provider-spend budget or make the process-local Redis-outage fallback a
multi-replica limit. Capacity configuration tests are in
`runtimeConfig.test.ts`, `streamCapacity.test.ts`, queue admission tests, and
the WS6 local Supabase capacity test.

### Production startup guard

`NODE_ENV` and `VAULTR_ENV` are trimmed and case-normalized. `production`,
`prod`, `staging`, `stage`, `preproduction`, `pre-production`, `preprod`, and
`preview` activate production checks. Explicit `development`, `dev`, `test`,
`local`, and `ci` modes preserve local/test behavior unless another mode value
is production-like. If no production-like mode is set but non-loopback public
service endpoints are configured, startup emits a warning that the production
guard is inactive. The production template sets `VAULTR_ENV=production`.

Production checks reject unsafe required secrets, insecure public URLs,
wildcard origins, unsafe model allowlists, missing storage/auth configuration,
and enabled debug flags before the API or worker starts. Warnings are
redacted. The guard cannot prove that a container or hosting platform uses
the production template. Tests: `productionConfig.test.ts`,
`productionDeploymentTemplates.test.ts`, runtime configuration tests, and
the local startup probes recorded in `audit.md`.

### Test network guard

Backend and frontend Vitest setup, Word server tests, and browser egress
checks block non-loopback network access by default and permit local test
services. There is no supported test opt-out. A new network client must have
a loopback fake and pass the pinned security suite. This rule is separate from
production egress controls and does not assert zero network traffic in a live
provider configuration. Tests: `networkGuard.test.ts`, browser egress guard
tests, and the egress coverage in `npm run test:security`.

## Residual and accepted-risk register

| Item | Status | Required follow-up |
| --- | --- | --- |
| Hosted R2/S3 signed-header and metadata enforcement, URL expiry/clock behavior, copy/overwrite/read-after-write, lifecycle/versioning, public access, CORS, endpoint addressing/TLS, and download overrides | Deployment verification required; local RustFS evidence does not prove hosted behavior. | Complete the tiny-object checks in [production setup](PRODUCTION_SETUP.md) against an approved disposable bucket before launch. |
| Production Supabase roles/migrations/RLS, Redis TLS/authentication/replica topology, DNS/egress/firewall, reverse proxy/TLS/CSP/CORS/cookies, OAuth dashboards, Google/MCP/CourtListener, Sentry retention/access, backups and restore | Not verified against a deployment or real provider. | Complete the owner launch gates in [production setup](PRODUCTION_SETUP.md). |
| Redis outage and no-Redis operation | Accepted process-local fallback; limits do not coordinate multiple API processes. | Use one API process or configure all replicas to share the same Redis. |
| Provider spending, durable queue size, and storage quota defaults | No global provider-spend cap; logical upload quotas default disabled; the job queue has finite admission caps. | Choose workload-specific provider budgets, queue alerts, and storage quotas before production use. |
| Remaining npm advisories | No High or Critical advisory remained after compatible lockfile updates. Production audits: root 0, backend 0, frontend 4 Moderate, Word 0. Full audits: backend 2 Moderate (development dependency path), frontend 4 Moderate, root 0, Word 0. The frontend advisories are in the transitive `uuid` path under ExcelJS/fortune-sheet; npm did not offer a compatible ExcelJS 4 fix. | Track compatible upstream fixes; reassess reachability and update lockfiles when available. Do not treat this as a confirmed exploit. |
| License review | No incompatibility with AGPL-3.0 was established. The production inventory contains one package (`buffers@0.1.1`) with no license field or packaged license text found, plus `FSL-1.1-MIT` in Sentry CLI packages. | Legal/maintainer review is required before redistribution; retain required third-party notices and attribution. |
| Private vulnerability contact | Not configured in this repository. | Fill the TODO in root `SECURITY.md` and confirm the selected channel works. |
| Hosted GitHub security settings and action immutability | Repository settings, branch protection, hosted CodeQL and secret-scanning state were not inspected. The new baseline CI steps use official actions pinned by major tags. | Owner should review GitHub settings and pin actions to verified full commit SHAs. |
| Maintainer ownership file | No `CODEOWNERS` file or listed code owners exists. | Add owners only after maintainers are identified. |

The production SBOMs and license inventory were generated outside the
repository during this pass. Their paths and scanner limitations are recorded
in the private `audit.md` addendum; they contain package metadata, not
credentials.

## Pre-launch gates

This baseline is not a production approval. Complete the detailed provider,
infrastructure, identity, storage, database, egress, monitoring, and recovery
checks in [docs/PRODUCTION_SETUP.md](PRODUCTION_SETUP.md) before real users or
client information are introduced.
