# Security Policy

## Supported versions

Security fixes are developed on `main`. After publication, the latest
`security-baseline-*` tag records the frozen baseline for that release; older
source snapshots and historical tags do not receive backports. Self-hosters
should use the latest published baseline or a newer reviewed `main` commit.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/sabarinath1805-loyal/vaultr-ai/security/advisories/new)
to report a suspected vulnerability privately to the repository maintainers.
Private vulnerability reporting is enabled for this repository. Do not open
a public issue containing sensitive vulnerability details.

Do not include real client documents, credentials, bearer tokens, signed URLs,
or production data in a report. Acknowledge receipt and coordinate disclosure
privately with the affected maintainers.

## Scope

In scope are vulnerabilities in this repository's application code, build and
test tooling, default configuration, migrations, and deployment guidance,
including tenant isolation, authentication, authorization, uploads and
downloads, parsers, AI/tool boundaries, BYO endpoints, and information
handling.

This repository is a local-first, bring-your-own-endpoint and
bring-your-own-model application. It has not been deployed as a hosted Vaultr
service. A third-party self-hosted installation's infrastructure or
operator-specific configuration is outside this repository's control and
should be reported to that operator. Production provider dashboards,
production DNS, real storage buckets, identity-provider tenants, external
integrations, and live model behavior are not authorized test targets for this
project's local security work.

Model behavior by itself is not an authorization boundary. Reports about
prompt injection are in scope when they demonstrate a code-level disclosure,
unauthorized tool action, or other reproducible application impact.

## Trust boundaries

| Boundary | Security assumption |
| --- | --- |
| Browser and Word add-in → API | Client input and model-triggered client actions are untrusted. The API authenticates requests and checks current authority. |
| API → database | The backend uses a privileged service-role client that bypasses row-level security. Application authorization and protected service credentials are essential. |
| API and workers → object storage | The bucket is private. Object keys are server-generated. Signed URLs are finite bearer capabilities. The provider enforces their signatures and expiry. |
| API and workers → Redis | Redis supports shared rate limits, stream leases, and queue transport when configured. Redis limits are not tenant authorization. Without a shared store, counters are process-local. |
| API → BYO model endpoint | The endpoint and its operator are outside the application's trust boundary. Prompts, user content, and permitted tool context may be sent to the selected endpoint. The app applies endpoint and outbound-URL policy. |
| API/workers → external integrations | Provider responses, OAuth data, MCP results, and external legal/search content are untrusted input. Credentials are connector- or user-scoped and outbound requests use guarded transports. |
| Test process → network | Automated tests run with a default-on guard that permits loopback test services and blocks non-loopback egress. This test guard is not a production firewall. |

## Accepted operating policies

- Upload and document-download signed URLs are capped at 900 seconds. Upload
  URL lifetime is additionally bounded by the upload session's expiry.
- Completed export artifacts are retained for 24 hours before the cleanup
  worker removes the artifact and job row.
- Revocation blocks subsequent protected reads, dispatches, and writes when
  they recheck current authority. A finite signed upload URL already issued
  can remain usable until expiry; completion and unaccepted worker promotion
  recheck destination authority. Output already emitted or an external
  operation already committed while access was valid cannot be recalled.
  Accepted lifecycle cleanup and account cleanup continue after the initiating
  user's access is revoked.
- Rate-limit and stream-capacity counters are process-local when no shared
  Redis store is configured and during Redis outage fallback. That mode is
  suitable only for one API process; multiple replicas need the same shared
  Redis service for shared counters. Redis outage fallback does not coordinate
  separate processes.
- The Word add-in loads Microsoft's Office.js platform script from Microsoft's
  CDN. This is an intentional external platform dependency.

## Local verification

Run the fixed regression suite from the repository root:

```bash
npm run test:security
```

See [the suite guide](docs/security-testing.md) and
[the frozen baseline](docs/SECURITY_BASELINE.md). Use synthetic data and
disposable local services only. Deployment-specific checks are listed in
[the production setup guide](docs/PRODUCTION_SETUP.md).
