# Security findings — 8 October 2026

Assessment snapshot: subsequent CI and GitHub protection changes are recorded in
[the security delivery report](SECURITY_MERGE_CI_BRANCH_PROTECTION_2026-10-08.md).
Original findings and test evidence below are preserved as assessed.

Assessment starts at `1c53d65fb17c688396a48aea0e21ec29fbdc5941`.
Priority P0–P3 is remediation order, separate from advisory severity. Findings
below are source-grounded; no production exploitation or customer data access
was attempted. No newly reported risk is marked accepted. Verification work
items are not counted as confirmed vulnerabilities.

## SEC-001 — MCP GET responses bypassed byte admission

**Medium / P2 / CWE-400 / Fixed.** Affected: `backend/src/lib/mcp/client.ts`,
`guardedFetch`; OAuth JSON discovery consumes its responses in `mcp/oauth.ts`.
Three GET/HEAD redirect-loop return paths returned an unwrapped response, unlike
POST/non-following requests. A connected malicious peer could return oversized
JSON despite the existing default 8 MiB response policy. Prerequisite: user
configures/connects an attacker-controlled MCP server, or an existing peer is
compromised. The boundary is remote connector content → API memory/resources.
No authentication bypass or cross-user token disclosure was demonstrated.

Fix: all terminal responses use the existing `boundedResponse`; redirect/DNS,
credential stripping and issuer-binding behavior is retained. Regression
`client.bounds.security.test.ts` failed before the fix (100 bytes accepted
under a 20-byte policy), then passed. It covers direct, redirected, chunked,
missing/invalid Location and normal JSON responses over loopback. Existing
SSRF mock now returns a fresh response body per request, matching real fetch.
Residual: a byte ceiling is not a complete provider availability guarantee;
SSE operation and live provider compatibility require integration verification.

## SEC-002 — Central API error console logs retained sensitive values

**Medium / P2 / CWE-532 / Fixed at the examined central boundaries.** Affected:
`backend/src/lib/httpError.ts:sendInternalError`,
`backend/src/middleware/internalErrorResponse.ts:protectInternalErrorResponses`.
Raw Error/cause or hand-written 5xx detail and concrete download paths reached
console output. Sentry's event scrubber is a separate boundary and does not
sanitize process logs. Prerequisites: a failure includes sensitive provider,
document, or capability text and an operator/log collector retains the output.
Synthetic regressions demonstrated the leak without real secrets.

Fix: central console diagnostics use opaque error categories, route patterns
and redacted capability paths. Explicit privacy-filtered Sentry reporting and
public API error contracts are retained. `reportedConsoleSummary` marks only
safe summary objects in the existing WeakSet to prevent duplicate console
capture, without retaining a hidden private error reference. Independent
same-label events remain reportable.

Tests: `httpError.test.ts`, `internalErrorResponse.test.ts`,
`observability/sentry.test.ts`; four new regressions failed before their
corresponding fixes and pass afterward. Residual: this is not a universal
console-output sanitizer. Other raw logging and operator retention need
continued review; full Git-history secret scanning was not executed locally.

## SEC-003 — Office extraction lacked expanded archive admission

**Medium / P2 / CWE-409, CWE-400 / Fixed for the listed parser paths.** Affected:
`backend/src/lib/officeText.ts`, four ZIP entry points in
`backend/src/lib/docxTrackedChanges.ts`, and tabular DOCX extraction in
`backend/src/modules/tabular/tabular.extract.ts`. Compressed upload limits
(100 MiB) did not bound decompressed XML/assets. Authorized document read or
extraction could expand attacker-uploaded Office content in-process.

Safe pre-fix evidence: a 2,384-byte synthetic presentation ZIP produced
2,097,164 text characters. Larger memory/CPU impact follows from the unbounded
code; no process crash or large attack payload was attempted. Authorization
still requires access to the document; this finding is not tenant bypass.

Fix: `officeArchive.ts:loadOfficeArchive` streams and counts actual bytes from
all entries before parsing, caps aggregate expanded content at 128 MiB and
resolved entries at 10,000, and returns opaque categorized failures. Forged
central-directory sizes do not establish the byte limit. Tabular admission is
outside the Mammoth fallback catch, so rejection cannot become empty success.

Tests: `officeArchive.security.test.ts` and
`officeParserAdmission.security.test.ts`; five initial admission regressions
failed before enforcement. Final tests cover aggregate non-XML assets, forged
size metadata, entry count, exact boundary, invalid archives, all tracked-change
read/write entry points, PPTX and fail-closed tabular/Mammoth admission. Test
inputs stayed at or below 2 MiB expanded.

Compatibility: archives previously accepted above these limits now fail
intentionally. No schema, OAuth scope, migration or reconnection is required.
Admission adds a streaming decompression pass; parsers then expand required
entries again. Residual: XML remains synchronous within bounds, central-directory
parsing precedes entry counting, and this is not a process RSS/deadline limit.
PDF, LibreOffice, browser DOCX rendering and separate Google Drive extraction
have distinct controls and are not certified by this fix.

## DEP-001 — braces recursive AST walkers

**High (upstream) / P2 / CWE-674 / Open; requires upstream fix.**
GHSA-vfj7-8cjw-p6xm / CVE-2026-93687. Latest 3.0.3 has no published patched
release. Frontend contributes seven affected-package findings; Word five.
Deep attacker-controlled patterns can exhaust recursive walkers. Identified
Next root/stories and Word proxy patterns are developer configuration; request
pathnames are candidates, not glob patterns. No live exploit was demonstrated.
See [dependency analysis](DEPENDENCY_SECURITY.md) for paths and rejected fixes.
No local patch, package rename, suppression or acceptance added.

## DEP-002 — node-forge nested DigestAlgorithm validation

**High (upstream) / P2 / CWE-347 / Open; requires upstream fix.**
GHSA-86w9-cpqp-85rv / CVE-2026-85393. Latest 1.4.0 has no published fix. Seven
Word affected-package findings inherit it. Exploitation requires malformed
attacker-controlled RSA verification input and the advisory's low-exponent
conditions. Examined Office/mkcert/TeamsFX consumers create/parse certificates;
the affected verification call was not identified there. This does not prove
all indirect paths unreachable. Unmerged PRs #1152 and #1157 are candidates
for independent cryptographic review, not verified releases. No ad hoc crypto
patch was applied. See [dependency analysis](DEPENDENCY_SECURITY.md).

## CFG-001 — GitHub main has no effective protection rules

**Medium / P2 / CWE-693 / Open; requires repository configuration.** Read-only
GitHub queries returned `Branch not protected` for classic protection and `[]`
for effective branch rules on main. Consequently local security checks are
not evidenced as mandatory merge gates. Prerequisites for harmful changes
include repository write authority or compromised maintainer credentials.
Recommended: require reviewed PRs and selected status checks, constrain force
push/deletion and choose administrator bypass policy. Owner must decide and
configure; no GitHub setting was changed. Re-query effective rules afterward.

## CFG-002 — Some CI actions use mutable version tags

**Low / P3 / CWE-829 / Open; requires reviewed workflow code change.**
`.github/workflows/ci.yml`, `security.yml` baseline job, e2e, mutation, Word,
stack, schema and image workflows contain tagged actions. Other jobs already
pin reviewed SHAs. Upstream tag compromise/retargeting could change executable
CI code. No action compromise was established. Pin verified equivalent commits
and maintain updates. Default GitHub workflow token permission was independently
read as `read`; PR-review approval disabled. No excessive current default token
permission is claimed. No workflows or deployment infrastructure changed.

## ARCH-001 — Custom MCP safety classification depends on peer annotations

**Medium design risk / P2 / Open; requires product policy decision.**
`backend/src/lib/mcp/client.ts` tool normalization requires confirmation for
explicit `readOnlyHint:false` or `destructiveHint:true`, but an enabled tool with
missing readOnlyHint can remain callable. `mcp/servers.ts` still reloads current
user-scoped connector/tool permissions; this is not a demonstrated cross-tenant
bypass. A malicious user-connected peer can misdescribe its side effects.
Recommended: operator/user-controlled trust classification and explicit approval
for unknown-effect tools. Default-denying existing connectors is a breaking
workflow change and was not silently introduced. Revocation/owner checks pass;
actual third-party effects and truthful annotations remain unverified.

## Verification ledger (not confirmed vulnerabilities)

| ID | Area | Status / remaining evidence |
| --- | --- | --- |
| VAL-AUTH | Authentication | Not Verified: deployed Supabase JWT audience/issuer/algorithm enforcement, real MFA and identity-provider dashboard behavior. Local tests mock provider responses. |
| VAL-DATA | Database/storage | Not Verified: live RLS/ACL/default privileges, migration convergence, bucket privacy, signed-header/expiry enforcement, deletion and backup restoration. Source and mocked checks are not provider evidence. |
| VAL-OFFICE | Word/browser journeys | Not Verified: real Office consent/sideload/message lifecycle, browser E2E and live document/network behavior. Node/jsdom tests and builds were run. |
| VAL-PRIVACY | Providers/telemetry | Not Verified: actual provider training/retention/residency, Sentry log access/retention, real deployment outbound traffic. No customer data or credentials were accessed. |

No new Critical or High application-code vulnerability was established in the
examined paths. This is a bounded assessment, not proof of absence.
