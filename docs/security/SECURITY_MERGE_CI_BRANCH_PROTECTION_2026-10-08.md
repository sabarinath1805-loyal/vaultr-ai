# Security merge, CI and main protection delivery

Requested report filename date: 2026-10-08. Execution continued on 9 October 2026 (Asia/Singapore). Evidence below distinguishes local validation, hosted checks and effective GitHub configuration. No production go-live certification is implied.

## A. Executive Summary

Final audit refresh: the earlier 0 Critical / 19 High / 0 Moderate / 0 Low snapshot changed without dependency or lockfile edits. Current full audits report **1 Critical / 19 High / 0 Moderate / 0 Low**, including newly reported Word development-tree handlebars advisories. Production-only audits remain zero. This task did not upgrade dependencies or suppress the new finding.

The comprehensive security branch was reviewed, freshly validated and fast-forwarded normally into remote main at d28bda0d40600bf59deb55b8e0c7c3901728fad8. CI pinning and explicit permissions were implemented in PR #1. Protection and repository-wide SHA enforcement are active. PR #1 merged normally after all eight required checks passed; its integration revision is 2b6bf585d05ed067e28f49b55d9f3b8da833faa3. No history rewrite, force push, branch deletion or production infrastructure change was performed.

## B. Git History

Original local and remote main: 1c53d65fb17c688396a48aea0e21ec29fbdc5941.
Security branch/integration SHA: d28bda0d40600bf59deb55b8e0c7c3901728fad8.
Previously validated fix commit: 28be6f29922ad3b474db60284815f18a261471b2.
CI-hardening commit: 8d009734728e82ebb582275e07b4656f312eb424.
Independent-audit follow-up: 381856106fcd02afb94dc9d8375375f2822744a4.
PR: https://github.com/sabarinath1805-loyal/vaultr-ai/pull/1.
CI merge commit and verified local/remote main at code integration: 2b6bf585d05ed067e28f49b55d9f3b8da833faa3. PR #1 merged at 2026-10-08T23:44:54Z.
Final Git SHAs and PR state appear in section K and the delivery evidence. The report's own commit cannot include its own SHA; final remote verification accompanies delivery.

## C. Security Changes Integrated

1. MCP GET/HEAD terminal responses now use existing boundedResponse policy.
2. Central 5xx console output uses opaque categories/redacted route patterns; explicit Sentry privacy filtering and deduplication remain.
3. DOCX tracked-change/PPTX/tabular paths admit at most 128 MiB actual expanded bytes and 10,000 resolved ZIP entries. This adds a decompression pass and intentionally rejects oversized files; it is not a process RSS/CPU deadline.

All seven previous reports are preserved. Source and lockfile diffs were reviewed; the limited added-line credential-pattern check found no matches. Full-history scanner results are separately recorded and are not substituted by that limited check.

## D. GitHub Actions Hardening

All 35 external uses across 11 workflows were inventoried. GitHub-maintained external actions are actions/* and github/codeql-action/*; third-party actions are docker/*, supabase/setup-cli and ossf/scorecard-action. No local/composite action, reusable workflow or dynamic action reference exists in the inspected tree. The guard handles local and Docker references distinctly and rejects mutable external/reusable refs. Docker images inside shell commands are outside action-reference scope and were not mislabeled as actions.

Official GitHub repository commit APIs resolved the original refs; upstream tag mappings and action.yml/action.yaml at the exact SHAs were verified. Major refs freeze their then-current intended versions; no cosmetic major upgrade was made. Already pinned actions were also reverified. Weekly Dependabot GitHub Actions maintenance already exists; no automatic merge policy added.
| Workflow | Action | Previous reference | New immutable SHA | Verified upstream version |
|---|---|---|---|---|
| ci.yml | actions/checkout | v7.0.1 | 3d3c42e5aac5ba805825da76410c181273ba90b1 | v7.0.1 |
| ci.yml | actions/setup-node | v7.0.0 | 820762786026740c76f36085b0efc47a31fe5020 | v7.0.0 |
| ci.yml | actions/checkout | v7.0.1 | 3d3c42e5aac5ba805825da76410c181273ba90b1 | v7.0.1 |
| ci.yml | actions/setup-node | v7.0.0 | 820762786026740c76f36085b0efc47a31fe5020 | v7.0.0 |
| codeql.yml | actions/checkout | 3d3c42e5aac5ba805825da76410c181273ba90b1 | 3d3c42e5aac5ba805825da76410c181273ba90b1 | v7.0.1 |
| codeql.yml | github/codeql-action/init | 1c5b675653bb5c22dbe9b12b556ec555138e09fd | 1c5b675653bb5c22dbe9b12b556ec555138e09fd | v4.38.1 |
| codeql.yml | github/codeql-action/analyze | 1c5b675653bb5c22dbe9b12b556ec555138e09fd | 1c5b675653bb5c22dbe9b12b556ec555138e09fd | v4.38.1 |
| docker-images.yml | actions/checkout | v7.0.1 | 3d3c42e5aac5ba805825da76410c181273ba90b1 | v7.0.1 |
| docker-images.yml | docker/setup-buildx-action | v3 | 8d2750c68a42422c14e847fe6c8ac0403b4cbd6f | v3.12.0 |
| docker-images.yml | docker/build-push-action | v6 | 10e90e3645eae34f1e60eeb005ba3a3d33f178e8 | v6.19.2 |
| e2e.yml | actions/checkout | v7.0.1 | 3d3c42e5aac5ba805825da76410c181273ba90b1 | v7.0.1 |
| e2e.yml | actions/setup-node | v7.0.0 | 820762786026740c76f36085b0efc47a31fe5020 | v7.0.0 |
| e2e.yml | supabase/setup-cli | v3 | 45a513f8c64c0bc8e0e3dfe572b5c95be85f6359 | v3.0.1 |
| e2e.yml | actions/upload-artifact | v7 | cf430e030ddbb5b0abf93d22962f4752f3646cd9 | v7.0.2 |
| gitleaks.yml | actions/checkout | 3d3c42e5aac5ba805825da76410c181273ba90b1 | 3d3c42e5aac5ba805825da76410c181273ba90b1 | v7.0.1 |
| mutation.yml | actions/checkout | v7.0.1 | 3d3c42e5aac5ba805825da76410c181273ba90b1 | v7.0.1 |
| mutation.yml | actions/setup-node | v7.0.0 | 820762786026740c76f36085b0efc47a31fe5020 | v7.0.0 |
| mutation.yml | actions/upload-artifact | v7 | cf430e030ddbb5b0abf93d22962f4752f3646cd9 | v7.0.2 |
| schema-drift.yml | actions/checkout | v7.0.1 | 3d3c42e5aac5ba805825da76410c181273ba90b1 | v7.0.1 |
| schema-drift.yml | supabase/setup-cli | v3 | 45a513f8c64c0bc8e0e3dfe572b5c95be85f6359 | v3.0.1 |
| scorecard.yml | actions/checkout | 3d3c42e5aac5ba805825da76410c181273ba90b1 | 3d3c42e5aac5ba805825da76410c181273ba90b1 | v7.0.1 |
| scorecard.yml | ossf/scorecard-action | 2d1146689b8cda280b9bc96326124645441f03bc | 2d1146689b8cda280b9bc96326124645441f03bc | v2.4.4 |
| scorecard.yml | github/codeql-action/upload-sarif | 1c5b675653bb5c22dbe9b12b556ec555138e09fd | 1c5b675653bb5c22dbe9b12b556ec555138e09fd | v4.38.1 |
| security.yml | actions/checkout | 3d3c42e5aac5ba805825da76410c181273ba90b1 | 3d3c42e5aac5ba805825da76410c181273ba90b1 | v7.0.1 |
| security.yml | actions/setup-node | 820762786026740c76f36085b0efc47a31fe5020 | 820762786026740c76f36085b0efc47a31fe5020 | v7.0.0 |
| security.yml | actions/checkout | 3d3c42e5aac5ba805825da76410c181273ba90b1 | 3d3c42e5aac5ba805825da76410c181273ba90b1 | v7.0.1 |
| security.yml | actions/setup-node | 820762786026740c76f36085b0efc47a31fe5020 | 820762786026740c76f36085b0efc47a31fe5020 | v7.0.0 |
| security.yml | actions/checkout | v7 | 3d3c42e5aac5ba805825da76410c181273ba90b1 | v7.0.1 |
| security.yml | actions/setup-node | v7 | 949feb2413d6458794dcd2491c4babbbce0c15c1 | v7.1.0 |
| stack-tests.yml | actions/checkout | v7.0.1 | 3d3c42e5aac5ba805825da76410c181273ba90b1 | v7.0.1 |
| stack-tests.yml | actions/setup-node | v7.0.0 | 820762786026740c76f36085b0efc47a31fe5020 | v7.0.0 |
| stack-tests.yml | supabase/setup-cli | v3 | 45a513f8c64c0bc8e0e3dfe572b5c95be85f6359 | v3.0.1 |
| word-addin.yml | actions/checkout | v7.0.1 | 3d3c42e5aac5ba805825da76410c181273ba90b1 | v7.0.1 |
| word-addin.yml | actions/setup-node | v7.0.0 | 820762786026740c76f36085b0efc47a31fe5020 | v7.0.0 |
| word-addin.yml | actions/upload-artifact | v7 | cf430e030ddbb5b0abf93d22962f4752f3646cd9 | v7.0.2 |

## E. Workflow Permissions

All workflow defaults are now permissions: {}. Each ordinary build/test/audit/image job explicitly receives contents:read. CodeQL analyze retains contents:read plus security-events:write. Scorecard analysis retains contents:read, security-events:write and id-token:write for existing OIDC publication. No repository-writing, PR-writing or broad read-all/write-all grant was added.

Existing events, path filters, job IDs/names, matrix entries, conditions, timeouts and security gates were compared against the original YAML and preserved. The audit matrix now explicitly uses fail-fast:false so a finding cannot cancel another workspace audit; earlier hosted evidence showed the Word audit cancelled after a frontend finding. Serial max-parallel:1 is retained. This change runs more evidence, rather than suppressing findings. No pull_request_target is used. Fork pull_request workflows do not receive repository secrets. The existing owner-PR E2E provider secret remains environment-bound; shell interpolation was replaced by printf using the environment. Word baseline builds now have required non-secret placeholder URLs. Raw Gitleaks JSON remains runner-temporary and is not uploaded; diagnostics print only finding location/rule/commit metadata while preserving failure status.

The new scripts/check-workflow-security.cjs validates YAML, workflow structure, full external SHAs, explicit permission policy and shell-input boundaries. Eight meaningful regression tests cover accepted/rejected refs, reusable workflows, permission scope, privileged PR events and safe environment handling. The tests are registered in the pinned suite; the policy runs in backend CI after its existing install. This guard is not a replacement for complete GitHub workflow semantic validation or supply-chain provenance review.

## F. GitHub Branch Protection

Active ruleset main-security-and-quality (ID 24756623) targets exactly refs/heads/main. Effective branch rules and detailed ruleset readbacks were inspected after creation. Legacy branch protection returns 404 because protection is supplied by the ruleset; there is no separate legacy rule to weaken.

| Protection | Requested | Actual status | Evidence |
|---|---|---|---|
| Pull request required | Yes | Enabled | Effective pull_request rule |
| Independent review | Yes | Exception: 0 mandatory approvals | GitHub lists only owner as eligible collaborator; 1 approval would leave no independent reviewer. Add reviewer, then raise requirement. No self-approval fabricated. |
| Required checks | Yes | Eight exact names, bound to GitHub Actions app 15368; strict up-to-date requirement | Effective required_status_checks rule |
| Conversation resolution | Yes | Enabled | required_review_thread_resolution:true |
| Force push blocked | Yes | Enabled | non_fast_forward rule |
| Deletion blocked | Yes | Enabled | deletion rule |
| Administrator enforcement | Where supported | Enabled; no bypass actors | bypass_actors:[] |
| Direct push blocked | Yes | Enabled by PR requirement | Configuration inspection only; no intentionally rejected push attempted |

Required contexts: Backend build and tests; Frontend build and tests; Frozen security baseline; Analyze (javascript-typescript); gitleaks (full history); audit-gate-tests; dependency-audit (root); dependency-audit (backend). Names came from actual PR check runs, not guessed workflow titles. PR #1 became BLOCKED while these checks were pending, confirming the ordinary merge path observes the rules.

Frontend/Word full dependency audits continue to run and fail on the documented unresolved High advisories; they were not disabled, suppressed or reclassified. They are not selected as required merge contexts because no official patched release is available and the user explicitly requires a workable protection configuration. This exception preserves a visible Open risk, not owner acceptance or a green full-audit claim. Optional/path-filtered/live-provider jobs are not mandatory contexts. Existing repository protections were absent; none weakened. Rules were applied while the CI PR waited so main is protected during that wait; the PR must use the protected merge path.

## G. Repository Security Features

| Feature | Actual status / evidence |
|---|---|
| Dependabot alerts | Already enabled; GET vulnerability-alerts returned 204 |
| Dependabot security updates | Enabled; readback enabled:true, paused:false |
| Secret scanning | Already enabled in repository security_and_analysis |
| Push protection | Already enabled for supported provider patterns |
| Private vulnerability reporting | Enabled; readback enabled:true; SECURITY.md now links the private reporting channel |
| Default Actions token | Already read-only; PR review approval disabled |
| External fork Actions approval | Strengthened from first-time contributors to all_external_contributors; read back |
| Dependabot action maintenance | Already configured weekly in .github/dependabot.yml; no auto-merge enabled |
| Dependency graph/SBOM | SBOM API returned 404; GraphQL dependencyGraphManifests returned totalCount:0. Alerts/updates are enabled, but graph population is not independently verified. GitHub documentation says enabling alerts generates the graph; this expected behavior is not treated as observed populated data. |
| Non-provider secret patterns / validity checks | Existing disabled state preserved; not represented as enabled |

Repository-wide sha_pinning_required:true was enabled after pinned workflows reached main and independently read back. Existing enabled:true and allowed_actions:all were preserved; workflow and server policy now both reject mutable external action refs. No repository secrets, deployment environments, production databases or existing integrations were changed.

## H. Local Test Results

From repository root with existing Node 22.23.3/npm 10.9.9:

| Exact command | Result |
|---|---|
| npm test --prefix backend -- --maxWorkers=2 | 2769 passed / 0 failed / 62 skipped |
| npm test --prefix frontend -- --maxWorkers=2 | 1679 passed / 0 failed / 0 skipped |
| npm run test:server --prefix word-addin | 3 passed / 0 failed / 0 skipped |
| npm run build --prefix backend | PASS |
| npm run typecheck:test --prefix backend | PASS |
| npm run typecheck:contracts --prefix backend | PASS |
| npm run lint --prefix frontend | PASS; 0 errors / 31 existing warnings |
| npm run typecheck --prefix frontend | PASS |
| npm run build --prefix frontend | PASS |
| REACT_APP_WEB_APP_URL=https://vaultr-build.invalid WORD_ADDIN_PUBLIC_URL=https://word-build.invalid npm run build --prefix word-addin | PASS, includes app/e2e typechecks; bundle warnings retained |
| node scripts/check-workflow-security.cjs | PASS; 11 workflows |
| node --test scripts/check-workflow-security.test.cjs | 8 passed / 0 failed / 0 skipped |
| npm run test:security (before security merge) | 1525 passed / 0 failed / 16 skipped |
| npm run test:security (after CI policy addition) | 1533 passed / 0 failed / 16 skipped |
| git diff --check | PASS |

Pinned suites overlap full suites; totals are not summed. Existing skips remain explicit. Fresh full and --omit=dev audits were run in backend/frontend/word-addin using npm audit --json, plus root --package-lock-only. Initial full C/H/M/L totals: 0/19/0/0 (frontend 7 High, Word 12 High); production-only zero across all four trees. Final refresh returned 1/19/0/0: root and backend zero; frontend 7 High; Word 1 Critical plus 12 High. The same commands and unchanged locks were used. JSON metadata validated; scanner exit 1 was vulnerability reporting, not ignored failure. No dependency reinstall/upgrade, lock change or audit suppression.

Local live cloud, Office, browser E2E, Docker, PostgreSQL/Redis and restore checks were not run. Hosted CI runs disposable services/browsers separately; their actual outcomes are recorded below. They do not prove hosted production configuration or real Microsoft Word behavior.

## I. Outstanding Risks

- New final-audit finding: development-tree handlebars has Critical advisories [GHSA-8r5x-fm3f-whwj](https://github.com/advisories/GHSA-8r5x-fm3f-whwj) and [GHSA-p8wg-vrv2-v86f](https://github.com/advisories/GHSA-p8wg-vrv2-v86f), plus Moderate GHSA-xw65-4hp5-5hc7 on the same package. npm counts the affected package at its maximum severity, so the overall Moderate package count remains zero. npm reports a fix available; validate a focused dependency remediation separately. The installed Word production-only tree remains zero. No production exploitability or application impact is inferred from the development audit alone.

- Optional hosted web E2E run [37860353274](https://github.com/sabarinath1805-loyal/vaultr-ai/actions/runs/37860353274) failed: 42 passed / 1 failed / 4 skipped. The tabular-review PDF upload test at e2e/tabular-reviews.spec.ts:271 timed out with Confirm disabled. Retry trace shows upload-session creation (201), signed URL requests (200), file-complete (200), and session polling (200); this isolates the observed failure to completion/selection after upload, but does not establish the underlying cause or prove it pre-existing. Retained as an open application/browser verification issue; assertions and checks were not weakened. No broad application change was made in this CI/settings task.

- Upstream dependency fix: braces GHSA-vfj7-8cjw-p6xm and node-forge GHSA-86w9-cpqp-85rv remain unresolved; CI pinning does not repair them. No owner risk acceptance invented.
- Code/architecture: parser CPU/RSS isolation beyond byte admission; custom MCP peer safety classification policy.
- External verification: real OAuth/MFA, deployed RLS/buckets, backup/deletion/restore, real Office, provider training/retention/residency.
- Review availability: only one eligible collaborator observed; an independent approval requires an additional reviewer. The actual configured exception is explicit below.
- Other supply-chain scope: shell-downloaded images/tools and future upstream commit compromise require separate maintenance; immutable refs prevent tag retargeting, not every compromise.

## J. Recovery Information

Local backup/main-before-security-merge-20261008 points to 1c53d65fb17c688396a48aea0e21ec29fbdc5941 and is preserved. Previous backup/main-before-author-rewrite is not deleted. Security and CI branches retained. Recover by reviewing a new revert PR against current main, running the required gates and merging through protection. Do not reset/force-push the backup over subsequent work. No rollback performed.

Mac impact: free disk was approximately 154 GiB at pre-flight; final measurement is recorded at delivery. No system-wide installation, new local service, browser bundle, Docker/Python/Xcode/Rosetta/VM installation or unrelated cache deletion.

## Hosted evidence recorded before final integration

- PR #1 first CI run 37857715086 passed both jobs: backend coverage 2769 passed / 62 skipped, frontend coverage 1679 passed; database approval/concurrent-claim script passed. Hosted frontend lint had 0 errors / 32 warnings (local lint had 31).
- Supabase stack run 37857714816 passed 62 tests across 10 files on disposable hosted infrastructure.
- Word browser-shim run 37857579395 passed 346 tests; this is not a real Microsoft Word test.
- CodeQL first run 37857714895 succeeded.
- Preliminary full-history scan 37858206177 passed across 631 commits. Prior failure was a generic-api-key match on prose in docs/security/THREAT_MODEL.md at historical commit d28bda0, line 68. The exact commit/file/rule/line fingerprint is excepted; no file-wide/value-wide rule or future-commit exception was added. No actual credential identified.
- Two superseded PR #1 runs were cancelled to avoid duplicate hosted work. Current-head runs and unrelated PRs were left intact.

Final CI head 381856106fcd02afb94dc9d8375375f2822744a4: CI run 37860353290, CodeQL 37860353332, secret scan 37860353449, Supabase stack 37860353411, Word browser shims 37860353351 and schema drift 37860353400 succeeded. Security run 37860353316 failed only the two known development audit jobs; its required gates passed. Optional web E2E failure is recorded in section I. Required gates passing does not mean every workflow passed.

## K. Final Code and Configuration Status

| Objective | Status | Evidence |
|---|---|---|
| Security branch integrated | Completed and verified | d28bda0d40600bf59deb55b8e0c7c3901728fad8 is an ancestor of local and remote main |
| CI actions pinned on main | Completed and verified | PR #1 merged as 2b6bf585d05ed067e28f49b55d9f3b8da833faa3; 35 immutable uses across 11 workflows; local guard passes; repository SHA enforcement read back true |
| Main protection | Completed and verified with documented review exception | Active ruleset 24756623, eight required contexts, no bypass actors; zero approvals because sole eligible collaborator |

At code-integration verification, local main and origin/main both equal 2b6bf585d05ed067e28f49b55d9f3b8da833faa3. The security branch and CI follow-up commits remain ancestors. Application directories match the validated CI head 381856106fcd02afb94dc9d8375375f2822744a4 exactly. No dependency/lockfile changed. The reporting-policy/documentation publication is a subsequent normal PR; its final merge SHA is recorded in the companion delivery artifact because a committed report cannot contain its own commit hash.

All eight required PR #1 checks passed on the final CI head; full security workflow remains failed on the two documented development dependency audits. No admin override, fabricated review, force push, history rewrite or branch deletion occurred. GitHub automatic branch deletion and automatic merge were read as false. Both recovery branches are preserved locally.

Required-check evidence (normalized):

| Required check | Final PR #1 result | Evidence |
|---|---|---|
| dependency-audit (backend) | SUCCESS | [GitHub job](https://github.com/sabarinath1805-loyal/vaultr-ai/actions/runs/37860353316/job/113594319799) |
| Frozen security baseline | SUCCESS | [GitHub job](https://github.com/sabarinath1805-loyal/vaultr-ai/actions/runs/37860353316/job/113594319578) |
| audit-gate-tests | SUCCESS | [GitHub job](https://github.com/sabarinath1805-loyal/vaultr-ai/actions/runs/37860353316/job/113594319801) |
| Frontend build and tests | SUCCESS | [GitHub job](https://github.com/sabarinath1805-loyal/vaultr-ai/actions/runs/37860353290/job/113594319662) |
| dependency-audit (root) | SUCCESS | [GitHub job](https://github.com/sabarinath1805-loyal/vaultr-ai/actions/runs/37860353316/job/113594319842) |
| gitleaks (full history) | SUCCESS | [GitHub job](https://github.com/sabarinath1805-loyal/vaultr-ai/actions/runs/37860353449/job/113594320189) |
| Analyze (javascript-typescript) | SUCCESS | [GitHub job](https://github.com/sabarinath1805-loyal/vaultr-ai/actions/runs/37860353332/job/113594319426) |
| Backend build and tests | SUCCESS | [GitHub job](https://github.com/sabarinath1805-loyal/vaultr-ai/actions/runs/37860353290/job/113594319352) |

Dependency-graph reference: [GitHub Dependabot alerts documentation](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-alerts). Graph population remains unverified: GraphQL returned zero manifests and SBOM REST returned 404; enabled alerts are not treated as proof of populated data.

Code/configuration verification timestamp: 2026-10-08T23:45:59.383Z
