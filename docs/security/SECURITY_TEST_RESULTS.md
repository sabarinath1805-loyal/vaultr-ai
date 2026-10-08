# Security verification — 8 October 2026

macOS arm64, Node 22.23.3, npm 10.9.9. Existing dependencies; no new services, Docker, Python environment or browser binaries. Tests use synthetic data, mocks and bounded loopback. Mocked provider behavior is not live integration evidence.

## Final broad commands (repository root)

Node directory prepended to PATH: /Users/sabarinathbabu/.local/node-v22.23.3-darwin-arm64/bin.

| Command | Result |
| --- | --- |
| npm test --prefix backend -- --maxWorkers=2 | 2769 passed, 0 failed, 62 skipped; 225 files passed, 10 skipped |
| npm run build --prefix backend | PASS |
| npm run typecheck:test --prefix backend | PASS |
| npm run typecheck:contracts --prefix backend | PASS |
| npm run test:security | 1525 passed, 0 failed, 16 skipped across Vitest/Node groups; overlaps full suites |
| npm test --prefix frontend -- --maxWorkers=2 | 1679 passed, 0 failed, 0 skipped; 217 files |
| npm run lint --prefix frontend | PASS: 0 errors, 31 existing warnings |
| npm run typecheck --prefix frontend | PASS |
| npm run build --prefix frontend | PASS |
| Frontend Ladle catalog build | PASS; exact command below |
| npm run test:server --prefix word-addin | 3 passed, 0 failed, 0 skipped |
| REACT_APP_WEB_APP_URL=https://vaultr-build.invalid WORD_ADDIN_PUBLIC_URL=https://word-build.invalid npm run build --prefix word-addin | PASS; placeholder domains, 3 bundle warnings |

Backend has no separate ESLint script. Existing skips preserved; infrastructure-dependent tests not counted as successful coverage. Builds do not establish runtime security.

## Targeted review and regressions

MCP byte regression failed before enforcement; two central-log and two console-dedup regressions failed before corresponding fixes. Office admission had five initial failing-before cases; final nine new archive/integration cases pass. Agent final targeted sets: auth/MCP/logging 95 tests; Office/architecture 41; document/browser boundary review 88; AI authorization 186. These overlap broad totals; never add them to full-suite totals. Exact targeted command ledger follows separately.

Registered three new security files and existing dependency tests in pinned membership. Synthetic/mock coverage includes owner-denial, OAuth binding/token isolation/SSRF, tool approval/revocation/replay, citations, document lifecycle/download/upload, unsafe rendering/URLs and malformed archives. Prompt-injection evidence concerns deterministic permission boundaries, not universal model resistance.

## Audits and baseline

Before/after in backend, frontend, word-addin: npm audit --json and npm audit --omit=dev --json. Root: same with --package-lock-only. Exit 1 means reported vulnerabilities; JSON metadata checked. Eight final raw JSON files retained outside Git. Contracts has no independent dependencies/lock: N/A. Bun resolution not verified.

Previous backend 2755 passed / 62 skipped; current +14 passed / same skips. Frontend unchanged at 1679, Word at 3. No executed final check failed. Fresh-response/valid-ZIP fixtures preserve assertions. Oversized archive rejection and an extra decompression pass are intentional compatibility changes.

Not run: browser E2E, real Word, live Supabase/RLS/storage/Redis, restore, real OAuth/MFA/provider sessions, LibreOffice runtime, deployment traffic/retention, local CodeQL/full-history Gitleaks, mutation/coverage campaigns. No fresh npm ci with unchanged lockfiles; no fresh-install claim. CI/settings inspected read-only; new Actions run not triggered.

Verification timestamp (UTC): 2026-10-08T13:07:40.962Z

## Exact targeted command ledger

All commands below ran at the repository root. Repeated identical commands are recorded with successive outcomes. These include expected reproduction failures and intermediate implementation failures; only final verified implementations are committed.

### MCP/authentication and privacy

```sh
npm test --prefix backend -- src/lib/mcp/__tests__/client.bounds.security.test.ts
```
Before fix: 1 failed, 0 passed, 0 skipped.

```sh
npm test --prefix backend -- src/lib/mcp/__tests__/client.bounds.security.test.ts src/lib/mcp/__tests__/client.ssrf.test.ts src/lib/mcp/oauth.test.ts src/lib/__tests__/outboundHttp.test.ts
```
50 passed / 1 failed / 0 skipped: reused response stream fixture corrected afterward.

```sh
npm test --prefix backend -- src/lib/mcp/__tests__/client.bounds.security.test.ts src/lib/mcp/__tests__/client.ssrf.test.ts src/lib/mcp/oauth.test.ts src/lib/__tests__/outboundHttp.test.ts src/modules/auth/__tests__/auth.test.ts src/lib/__tests__/authSession.test.ts src/lib/__tests__/authHandoff.test.ts src/middleware/authLogging.test.ts
```
94 passed / 0 failed / 0 skipped.

```sh
npm test --prefix backend -- src/lib/httpError.test.ts src/middleware/internalErrorResponse.test.ts
```
Before fix: 13 passed / 2 failed / 0 skipped.

```sh
npm test --prefix backend -- src/lib/httpError.test.ts src/middleware/internalErrorResponse.test.ts src/lib/observability/sentryPrivacy.test.ts src/lib/observability/sentry.test.ts src/middleware/authLogging.test.ts
```
Successive runs: 91 passed / 2 failed (redacted-route expectation correction); 93 passed / 0 failed; final 95 passed / 0 failed. No skips.

```sh
npm test --prefix backend -- src/lib/observability/sentry.test.ts
```
Before dedup fix: 42 passed / 2 failed / 0 skipped. Backend build command in broad ledger also ran successfully three times during this review.

### Documents/browser/Word boundaries

```sh
npm test --prefix frontend -- src/app/components/shared/views/DocxView.security.test.tsx src/app/components/shared/views/DocxPreview.security.test.tsx src/app/components/assistant/CaseView.test.tsx src/shared/lib/contentSecurityPolicy.test.ts src/shared/security-tests/wordOAuth.security.test.ts
```
4 files / 11 passed. Final wordOAuth filter matched no existing file: no coverage attributed to that filter.

```sh
npm test --prefix backend -- src/modules/documents/__tests__/documents.download.test.ts src/modules/uploads/__tests__/uploads.manifest.test.ts src/lib/__tests__/downloadTokens.test.ts src/lib/__tests__/docxTrackedChanges.test.ts src/lib/__tests__/convertTimeout.test.ts src/__tests__/integration/documentsFile.routes.test.ts
npm test --prefix frontend -- src/app/lib/authRedirects.test.ts src/wordAddin/client.test.ts src/app/components/settings/GoogleWorkspacePanel.test.tsx
```
Respectively 49 and 28 passed, no failures/skips. Combined boundary review: 88 tests (39 frontend, 49 backend).

```sh
npm test --prefix backend -- src/lib/__tests__/officeArchive.security.test.ts
```
Before enforcement: 5 failed / 1 passed.

```sh
npm test --prefix backend -- src/lib/__tests__/officeArchive.security.test.ts src/lib/__tests__/docxTrackedChanges.test.ts src/modules/tabular/__tests__/tabular.extract.sanitize.test.ts
```
Intermediate implementations: 25 failed / 4 passed (unsupported async iterator); 29 passed but 6 unhandled errors, exit 1 (invalid pass); final streaming implementation 29 passed / 0 failed / 0 unhandled.

```sh
npm test --prefix backend -- src/lib/__tests__/officeArchive.security.test.ts src/lib/__tests__/officeParserAdmission.security.test.ts src/lib/__tests__/docxTrackedChanges.test.ts src/modules/tabular/__tests__/tabular.extract.sanitize.test.ts
npm test --prefix backend -- src/lib/__tests__/officeArchive.security.test.ts src/lib/__tests__/officeParserAdmission.security.test.ts src/lib/__tests__/docxTrackedChanges.test.ts src/modules/tabular/__tests__/tabular.extract.sanitize.test.ts src/__tests__/architecture.test.ts
```
Respectively 32 and final 41 passed / 0 failed / 0 unhandled. Backend build initially failed because bundled JSZip types omit documented internalStream; narrow structural interface corrected it, build passed. Test typecheck passed. Diff check passed.

### AI authorization

```sh
npm test --prefix backend -- src/modules/chat/engine/tools/toolCapabilities.test.ts src/modules/chat/engine/tools/__tests__/toolDispatcher.revocation.test.ts src/modules/chat/engine/__tests__/streamingRevocation.test.ts src/modules/chat/engine/__tests__/streamingToolGating.test.ts src/modules/chat/engine/__tests__/streamingModelAllowlist.test.ts src/modules/chat/engine/__tests__/googleWorkspaceDispatch.test.ts src/modules/chat/engine/contextBuilders.docAccess.test.ts src/lib/integrations/__tests__/googleWorkspace.test.ts src/lib/mcp/servers.test.ts
npm test --prefix backend -- src/modules/memory/__tests__/memory.curator.revocation.test.ts src/modules/tabular/__tests__/tabular.rows.revocation.test.ts src/lib/__tests__/chatPrompts.test.ts src/lib/__tests__/toolDispatcherSpotlight.test.ts src/modules/chat/engine/__tests__/requestValidation.test.ts src/modules/chat/engine/tools/wordClientTools.test.ts
```
Respectively 99 and 87 passed, zero failed/skipped. No changes needed from this review.

Exact catalog command: `npm run catalog:build --prefix frontend`.

Final report/audit verification timestamp (UTC): 2026-10-08T13:08:44.849Z
