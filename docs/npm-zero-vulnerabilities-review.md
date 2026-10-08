# npm security follow-up — 8 October 2026

Starting commit: `c255cd54c09bdd267d4cb34bab668d306c90cb76`.
Branch: `security/npm-zero-vulnerabilities`.

## Result and scope

The zero-vulnerability target is **not achieved**. Complete lockfile audits,
including development dependencies, were performed for backend, frontend,
root, and Word add-in. Root was audited without installing its deferred test
packages. Word dependencies were installed for clean-install/build validation;
no browser binaries, certificates, sideload configuration, or remote resources
were created. No audit exceptions, metadata substitutions, or source patches.

| Tree | Before critical/high/moderate/low | After critical/high/moderate/low |
| --- | --- | --- |
| Backend | 0 / 0 / 3 / 0 | 0 / 0 / 0 / 0 |
| Frontend | 0 / 7 / 3 / 0 | 0 / 7 / 0 / 0 |
| Root | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| Word add-in | 2 / 15 / 1 / 0 | 0 / 12 / 0 / 0 |

Supplemental production-only audits are zero for all four trees. These do not
replace the full audits: the 19 remaining high package findings are included
in the overall result and represent two distinct upstream advisories.

## Changes

### Remove the sprintf-js dependency path without replacing Mammoth

Mammoth remains at 1.12.3. A scoped override selects official argparse 2.0.1
instead of 1.0.10 in backend and frontend. The newer JavaScript implementation
has no sprintf-js dependency. Its `Python-2.0` license name does **not** require
Python or install a Python runtime.

Source inspection and tests verified retained legacy aliases: addArgument,
addMutuallyExclusiveGroup, parseArgs, addHelp, defaultValue, and string types.
Mammoth's CLI still accepts its positional document/output arguments,
--output-dir, --output-format, and --style-map. Legacy aliases emit upstream
deprecation warnings when the CLI is invoked; ordinary Mammoth library imports
and document processing do not invoke argparse. No application code changed.

Regression checks cover help, real synthetic DOCX conversion, invalid flags,
and mutually exclusive output options, alongside library DOCX extraction.
This removes GHSA-hp3w-g68c-fv3c rather than hiding it or downgrading Mammoth.
The latest Mammoth 1.13.0 still requests argparse 1.x, so a parent update alone
would not remove this path. No unrelated dependency upgrades were needed.

### Word add-in fixes

All updates remain within the existing parent dependency ranges; no new
manifest overrides or direct dependencies were needed.

| Package | Before | After | Advisory |
| --- | --- | --- | --- |
| @modelcontextprotocol/sdk | 1.30.0 | 1.32.1 | GHSA-6qxp-vccf-f47h |
| compression | 1.8.1 | 1.8.2 | GHSA-vc2v-76pw-4v95 |
| postcss-selector-parser | 7.1.4 | 7.1.6 | GHSA-rj75-hqrm-r3gf |
| proxy-addr | 2.0.7 | 2.0.8 | GHSA-jqcg-44mw-7w3h |
| shell-quote | 1.9.0 | 1.12.0 | GHSA-pqg4-j6r4-53mv |
| source-map-js | 1.2.1 | 1.2.2 | GHSA-68fv-2mgg-jv7q |

These are official npm distributions from their existing upstream projects.
The lockfile diff contains only those six version updates and associated
metadata; compression reuses the already-present destroy 1.2.0 package.
No new package paths or install scripts were introduced.

Exposure: proxy/compression are dev-server dependencies, shell-quote serves
launch-editor/TeamsFX tooling, selector/source-map processing belongs to CSS
build tooling, and MCP SDK serves TeamsFX's HTTP MCP tool discovery. The SDK
transport API still loads through the consumer's CommonJS imports. Vaultr's
own OAuth issuer-binding implementation is unchanged and its regression tests
remain part of the complete backend suite.

Behavioral security checks include mapped-subnet proxy trust, safe rejection
of newline-bearing shell tokens (without executing a shell), bounded CSS
selector parsing, and gzip-stream destruction after an aborted local response.
Glob compatibility checks exercise nested alternatives, padded ranges,
escaped literals, and matching; no malicious stack-exhaustion payload is run.

## Remaining advisories and investigated alternatives

### braces 3.0.3 — high

[GHSA-vfj7-8cjw-p6xm / CVE-2026-93687](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
The registry still reports 3.0.3 as latest, with no patched release; the upstream
issue remains open. Affects frontend and Word tooling through micromatch.
Frontend includes Ladle → globby → fast-glob → micromatch → braces and
Next's ESLint plugin → fast-glob → micromatch → braces. Word's webpack tooling
also uses micromatch. Seven frontend and five Word high package findings are
attributed to this advisory (some Word parents also inherit node-forge).

Exploit precondition: attacker-controlled deeply nested brace patterns reach
recursive compile/expand walkers. The identified consumers use developer-
controlled patterns; no direct production application import was identified.
Avoid untrusted patterns and unreviewed build configuration.

Fresh parent checks: latest Ladle 5.1.1 still uses globby 14, micromatch 4.0.8
still uses braces 3, and Next ESLint plugin 16.4.0 still uses fast-glob 3.
A major parent change does not provide a known patched tree.

Picomatch is maintained but is not a drop-in braces replacement: braces exposes
AST parsing, stringify, compile, and range expansion APIs. The discovered
@clevercanyon/braces.fork 3.0.146 predates the advisory (registry modified March
2025), declares engines excluding Node 22, and adds a forked fill-range tree.
Its different package name is not evidence of a security fix; it was rejected.

A narrow depth-guard patch is technically possible but must cover parsed
strings AND caller-supplied ASTs, compile, expansion, stringify, malformed input,
and caller error handling. An arbitrary max-depth guard changes accepted
public input, while a full iterative rewrite has a larger compatibility burden.
Standard reproducible patch-package/vendored-source installation also requires
patch assets before npm ci. Existing images copy only package*.json before npm
ci; silently skipping missing patches would leave images vulnerable. Changing
that deployment infrastructure was explicitly excluded. No fragile inline
manifest patcher or unverified local fork was introduced. Even a correct local
source patch would remain reported against the original npm version.

### node-forge 1.4.0 — high, Word tooling

[GHSA-86w9-cpqp-85rv / CVE-2026-85393](https://github.com/advisories/GHSA-86w9-cpqp-85rv).
Latest published version is still 1.4.0; the advisory has no patched release.
Paths include Office dev-certs → mkcert → node-forge and Office dev-settings →
M365 Agents Toolkit → TeamsFX → node-forge. Audit inheritance also affects
Office debugging and webpack's dev-server/proxy certificate tooling.

Exploit precondition: RSA PKCS#1 v1.5 verification of attacker-controlled
signatures with specially malformed nested DigestAlgorithm ASN.1 structures.
Inspected mkcert and TeamsFX local-certificate consumers create/sign certificates;
the vulnerable verification call was not identified in those direct consumers.
This is not proof that every transitive tool path is unreachable. Do not use
this tree to validate untrusted certificates or signatures.

Latest Office debugging 7.0.1/dev-certs 3.0.1/mkcert 3.2.0 and TeamsFX 3.1.3
still retain node-forge. A WebCrypto/X.509 alternative is not API compatible
with Forge's pki/asn1 interfaces and requires replacing certificate tooling.
A cryptographic verification patch needs upstream/security review and ASN.1
positive/negative interoperability tests; an ad-hoc rewrite is not defensible
merely to obtain a zero audit. Original package identities are preserved.

## Validation and follow-up

Run `node --test scripts/dependency-security.test.cjs` after installing all
three app dependency trees for eight focused compatibility/security tests.
Backend/frontend complete suites, type checks, lint, builds and ordinary
lockfile installs are required before committing. Word server tests and app/
E2E TypeScript checks are included; browser E2E, actual Office sideloading,
keychain integration, and service-dependent integration remain deferred.

Word production builds need REACT_APP_WEB_APP_URL and WORD_ADDIN_PUBLIC_URL.
Validation uses temporary reserved .invalid HTTPS origins only; no .env file,
credential or deployed configuration is created. Its bundle-size warnings are
recorded rather than weakened.

Safest next action: obtain reviewed upstream fixes for braces and node-forge,
or separately authorize and review maintained forks plus reproducible patch
asset distribution in the image build. Continue to report the full audit until
independent audits actually reach zero. This commit is a partial remediation,
not a claim that the zero target has been met.

### Final executed validation

- Ordinary `npm ci` passed in backend, frontend, and Word add-in, including
  existing lifecycle scripts. Native keytar used its existing ARM64 prebuilt
  binary mechanism; no Python or compiler infrastructure was installed.
- Backend: 2,755 passed, 62 skipped; production build, test type check and
  contracts type check passed. OAuth issuer regression cases are unchanged.
- Frontend: 1,679 passed; type check and build passed; lint stayed at zero
  errors and 31 warnings.
- Word: three server tests, both TypeScript checks and production build passed;
  three bundle performance warnings remain. Build-only .invalid origins used.
- Dependency regression suite: eight passed, zero skipped.
- One intermediate frontend run encountered missing modules because dependency
  refresh overlapped validation. It was invalidated and rerun successfully
  after installation completed. No tests were weakened or newly skipped.

Storage: free SSD space was 159 GiB before and approximately 157 GiB after;
repository grew from 2.3 to 3.1 GiB, primarily the newly validated Word tree
(~753 MiB). npm cache grew from 428 to ~596 MiB. Build outputs: backend 5.2 MiB,
frontend ~411 MiB, Word ~2.3 MiB. No component approaches 10 GiB; free space
remains above 120 GiB. No cleanup performed. Complete lockfile entries changed
by -1 backend, -2 frontend, zero Word/root; no new package paths were added.
Frontend multi-version package names decreased from 138 to 137.
