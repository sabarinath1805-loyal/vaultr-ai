# Dependency security — 8 October 2026

Fresh audits include development dependencies; npm's affected-package counts
are not distinct advisory counts. All four independent npm lockfile trees were
audited. Backend/frontend/Word also had installed trees available. Root used a
complete lockfile audit without installing browser tools. `packages/contracts`
is a declarations-only package with no dependencies or independent lockfile;
no separate installed-tree audit is claimed. Bun lockfiles were identified but
this assessment verifies the npm/CI installation path, not Bun resolution.

| Tree | Full C/H/M/L | Production C/H/M/L | Method |
| --- | --- | --- | --- |
| Backend | 0/0/0/0 | 0/0/0/0 | npm audit; installed tree |
| Frontend | 0/7/0/0 | 0/0/0/0 | npm audit; installed tree |
| Root | 0/0/0/0 | 0/0/0/0 | npm audit --package-lock-only |
| Word add-in | 0/12/0/0 | 0/0/0/0 | npm audit; installed tree |

Before/after counts are unchanged. Overall 19 high affected-package findings
represent two distinct advisories. All affected locations are development
packages. Production-only results are supplemental and do not replace the
full-tree totals. No dependency/lockfile upgrade, unsafe override, audit
exception or metadata substitution was introduced in this assessment. The
existing historical tmp allowlist entry was not expanded or used to hide the
two current advisories; the dependency gate remains capable of failing them.
Raw JSON responses are retained outside Git in the task's evidence artifacts,
consistent with repository rules; scanner logs are not committed.

## braces

[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm),
CVE-2026-93687: High, no patched release; latest registry version 3.0.3.

- Frontend: Ladle → globby → fast-glob → micromatch → braces.
- Frontend: eslint-config-next → @next/eslint-plugin-next → fast-glob →
  micromatch → braces.
- Word: webpack-cli → webpack-dev-server → http-proxy-middleware → micromatch
  → braces.

Affected frontend package names: @ladle/react, @next/eslint-plugin-next,
braces, eslint-config-next, fast-glob, globby, micromatch (seven). Word braces
path: braces, http-proxy-middleware, micromatch, webpack-cli, webpack-dev-server
(five). Instance counts can exceed names: frontend installs two fast-glob
locations. Distinguish those instances from advisory totals.

Source and fresh metadata confirm latest checked parents retain the path:
Ladle 5.1.1, Next plugin 16.4.0 and micromatch 4.0.8. Deeply nested patterns can
exhaust recursive compile/expand/stringify AST walkers. Next rootDir settings
and Ladle story patterns are developer-controlled; Word's configured proxy
contexts are plain prefixes. Reviewed request input is not promoted to a glob
pattern. No full reachability proof is claimed for all dependencies.

Maintained matching/file discovery alternatives such as picomatch/tinyglobby
are not equivalent to braces AST APIs or all micromatch/globby semantics.
The discovered Clever Canyon fork predates the advisory and excludes Node 22
in its engine declarations; a different package identity is not a security fix.
Replacing one parent leaves the other paths. Deduplication leaves the shared
vulnerable implementation. A reviewed depth-bound/iterative walker change
needs string and supplied-AST coverage and caller failure semantics.

## node-forge

[GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv),
CVE-2026-85393: High, no patched release; latest registry version 1.4.0.

- Word: office-addin-dev-certs → mkcert → node-forge.
- Word: office-addin-debugging → office-addin-dev-settings → required peer
  @microsoft/m365agentstoolkit-cli → @microsoft/teamsfx-core → node-forge.

Seven inherited package findings: toolkit CLI, TeamsFX core, mkcert, node-forge,
Office debugging, dev-certs and dev-settings. Latest settings 4.0.1 still has
its toolkit peer; examining dependencies alone misses that path. Latest
Office dev-certs 3.0.1/mkcert 3.2.0 retain Forge. RSA verification fails to
reject extra nested DigestAlgorithm elements under the advisory's prerequisites.
Direct inspected certificate consumers generate/sign/parse local certificates;
affected signature verification was not observed in them, without claiming
universal unreachability.

Upstream [PR #1152](https://github.com/digitalbazaar/forge/pull/1152) and
[supplement #1157](https://github.com/digitalbazaar/forge/pull/1157) remain
unmerged, unreleased patch candidates. The supplement's NULL-parameter checks
reinforce the need for independent cryptographic review. Node crypto is not a
drop-in Forge pki/asn1/certificate API replacement. No improvised crypto,
permissive verification or unverified fork was installed.

## Residual controls and next action

Keep untrusted build configurations/glob patterns outside developer/CI trust,
review dependency PRs and lifecycle scripts, keep least-privilege CI tokens,
and avoid using these tools to validate untrusted cryptographic input.
Compensating controls reduce exposure; they do not eliminate vulnerabilities
or mean owner acceptance. Existing images install manifests before copying
source, so local patch assets need reproducible availability in every install
context. Deployment edits were not made.

Safest next step: reviewed upstream releases followed by narrow upgrades,
clean installs, behavior tests and independent full audits. If urgent, a
separately reviewed maintained backport needs ownership, trusted negative and
positive crypto vectors, full brace API compatibility and reproducible
packaging. Continue reporting **0 Critical / 19 High / 0 Moderate / 0 Low**
until actual audits and implementation evidence change.
