# npm security remediation — 7 October 2026

Historical report: [8 October follow-up](npm-zero-vulnerabilities-review.md)
removes the sprintf-js path using a compatibility-tested argparse override.

Scope: backend and frontend npm dependencies at baseline commit
`8853ec5a352e35a54d5765c3cdc6c6cc7208687f`. Root and Word add-in
lockfiles are unchanged. No audit suppressions or forced dependency upgrades.

## Patched dependencies

| Dependency | Baseline | Remediated | Reason and compatibility |
| --- | --- | --- | --- |
| @modelcontextprotocol/sdk | 1.30.0 | 1.31.0 | First patched 1.x release for GHSA-6qxp-vccf-f47h; retain the existing SDK API. |
| proxy-addr (both apps) | 2.0.7 | 2.0.8 | First patched release for GHSA-jqcg-44mw-7w3h; Express's existing range accepts it. |
| source-map-js (both apps) | 1.2.1 | 1.2.2 | Patch for GHSA-68fv-2mgg-jv7q within existing parent ranges. |
| sharp | 0.35.4 | 0.35.5 | Existing override raised one patch; bundled librsvg 2.63.2 fixes GHSA-wq5f-xc86-pv6w. |
| qs under typed-rest-client | 6.15.1 | 6.16.0 | Scoped override of the parent's exact pin; retains the 6.x query-string API. Fixes GHSA-q8mj-m7cp-5q26, GHSA-x5fp-wj9c-mxmx, GHSA-4mjr-xmp4-gh2g. |
| uuid | 8.3.2 | 11.1.1 | Evaluated major override: Fortune Sheet and ExcelJS use the supported named v4 API without buffers. 11.1.1 retains CommonJS and browser exports; fixes GHSA-w5hq-g745-h8pq. |
| nested katex | 0.16.47 | 0.18.7 | Reuse the existing direct KaTeX version through `$katex`; both math adapters use renderToString, which remains supported. Fixes GHSA-238p-pmpm-9mq7. |

UUID v4/CommonJS loading, ExcelJS loading, Markdown math rendering through
remark-math/rehype-katex, and Sharp SVG-to-PNG decoding were checked in addition
to the application test suites and builds. The override crosses a UUID major
and KaTeX minor boundary deliberately; it does not replace either package with
an unrelated implementation.

### Proxy trust and source maps

One proxy-addr installation existed in each application: backend Express,
and frontend OpenNext AWS's Express dependency. Both are patched. Backend
`app.ts` uses numeric `TRUST_PROXY_HOPS` (default 1), not the misconfigured IPv6
subnet condition described by the advisory. This observation is specific to
that advisory, not a general endorsement of every deployment's proxy topology.

source-map-js comes through Vite/PostCSS/coverage tooling, with additional
frontend Tailwind/css-tree paths. No application API accepting attacker-supplied
indexed source maps was identified. Patching avoids relying on that mitigation.
Sharp SVG decoding can be reached through image-processing dependencies and
was patched rather than disabled.

### MCP credential binding

Vaultr supplies its own HTTP OAuthClientProvider. An SDK upgrade alone would
lose protection if its issuer field were discarded by custom database storage.
`DbMcpOAuthProvider` now persists and restores issuer using the existing
`authorization_server` column for client information and tokens. Google and
Slack pre-registered credentials are pinned to their public authorization
server identities (`https://accounts.google.com` and `https://mcp.slack.com`).
These identities were checked against public Google discovery and Slack
protected-resource metadata without credentials.

Legacy stored credentials without an authorization server are withheld, so
users of those connectors may need to reconnect/re-register. Existing
resource/connector binding remains in force. No schema changes, migrations,
or remote credential changes were performed. Four regression tests cover
client and token issuer round trips, pinned providers, and legacy credentials.

## Remaining findings: NOT CURRENTLY FIXABLE

### braces — high, frontend only

[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
affects all published versions through 3.0.3; no patched release exists.
The audit counts seven affected packages: braces, micromatch, fast-glob,
globby, @ladle/react, @next/eslint-plugin-next, and eslint-config-next.
Paths are Ladle → globby → fast-glob → micromatch → braces and
ESLint's Next plugin → fast-glob → micromatch → braces.

The vulnerability requires attacker-controlled deeply nested brace patterns.
No production application imports of these glob packages were found; the
identified paths consume developer-controlled source/tooling patterns.
Do not pass untrusted patterns to those tools. Revisit when upstream publishes
a patch. Downgrading Next's lint configuration or removing Ladle would change
supported tooling rather than provide a verified equivalent fix.

### sprintf-js — moderate, both apps

[GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)
affects every published version through 1.1.3; no patched release exists.
The audit counts three affected packages per app: sprintf-js, argparse, mammoth.
Both paths are Mammoth 1.12.3 → argparse 1.0.10 → sprintf-js 1.0.3.

The vulnerability requires attacker-controlled precision format strings.
Mammoth imports argparse in its command-line executable, not its library
modules; Vaultr uses the Mammoth document-conversion library. No application
use of sprintf-js or attacker-controlled CLI formatting was identified.
Avoid exposing Mammoth's CLI to untrusted arguments and monitor upstream.
The npm-proposed downgrade to Mammoth 0.3.29 is an obsolete incompatible
version, not a safe remediation.

## Validation

Backend: 2,755 tests passed (four added), 62 skipped; build, test type check,
and contracts type check passed. Backend build includes production type checking.
Frontend: 1,679 tests passed; type check and production build passed; lint
retained the baseline of zero errors and 31 warnings. Service-backed tests,
container tests, browser tests, and Word add-in validation remain out of scope.
