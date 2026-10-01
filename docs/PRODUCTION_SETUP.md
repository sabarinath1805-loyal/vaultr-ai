# Vaultr-AI production setup and launch gates

This guide prepares the first production deployment. The repository has not
been deployed to a live environment, and this project cannot see or verify the
owner's hosting, Supabase, Redis, storage, DNS, OAuth, GitHub, or Sentry
accounts. Complete every applicable launch gate below on the real accounts
before inviting users or putting client information into the service.

The bundled production Compose file is a template for this topology:

- Caddy is the only container with public ports: 80 and 443.
- The web app and Word add-in sit behind Caddy and proxy API requests to the
  backend. They share a private API network with the backend but cannot reach
  Redis. The backend, worker, and password-protected Redis share a separate
  private network and have no host ports.
- Supabase and S3-compatible object storage are managed services outside the
  Docker networks. The backend and worker need outbound TLS access to those
  providers. The Compose `provider_egress` network does not create a cloud
  egress allowlist; apply outbound restrictions in the host or cloud firewall.
- The template builds the three application images on the host. Use an
  immutable release name and record the source commit for every deployment.

If your hosting provider cannot keep the backend and Redis private, if a CDN is
placed in front of Caddy, or if you choose different providers, stop and have
the network and trusted-proxy design reviewed before deployment. The template
does not configure a CDN trust chain.

## 1. Create separate production services

Create a production hosting project or host with Docker Engine and current
Docker Compose v2. Create separate staging resources as well; never share
production databases, buckets, OAuth clients, Redis, or credentials with
staging. Keep test data synthetic.

Create these services in the production accounts:

1. A Linux host or private container service for the Vaultr application.
2. A Supabase project for Postgres and Supabase Auth.
3. A private S3-compatible bucket and restricted application credentials.
4. A password-protected Redis service. The supplied template runs Redis in a
   private container with AOF persistence and no published port. If you use a
   separate managed Redis service, use a private TLS endpoint (`rediss://`),
   restrict its network allowlist to the app host, and update the Compose
   service configuration through a reviewed deployment change.
5. DNS names for the web app and Word add-in. Both must resolve to the Caddy
   host before Caddy can obtain public certificates.

In the host firewall, allow public inbound TCP 80 and 443 to Caddy. Do not
publish backend 3001, Redis 6379, Postgres 5432, or an object-storage admin
endpoint. Restrict SSH, provider dashboards, and database administration to
named administrators using MFA and access logs. Allow backend and worker
outbound TLS only to the configured Supabase, storage, model, and explicitly
enabled integration providers where your hosting platform supports destination
restrictions. See WS7-A-02, WS7-A-04, WS7-F-03, WS7-L-01, and WS7-M-01.

## 2. Configure Supabase before loading data

In the Supabase project dashboard, record the project URL, publishable key,
secret service-role key, and the project's JWT signing secret. Put the
service-role key only in the backend secret store. Never put it in frontend or
Word add-in build settings.

In **Authentication → URL Configuration**:

- Set the Site URL to the exact production web origin, such as
  `https://app.your-domain.example`.
- Add only active callback URLs. At minimum, add
  `https://app.your-domain.example/auth/callback`. If Word sign-in is enabled,
  also add
  `https://word.your-domain.example/oauth-dialog.html`.
- Remove localhost, preview, retired, wildcard, and staging URLs from the
  production project.

In **Authentication → Providers / Email**:

- Enable only the identity providers you intend to support.
- Enable email confirmation for public signups and configure production SMTP.
- Require confirmation at both the old and new addresses for email changes.
- Set the minimum new-password length to 10 characters.
- Review signup, password-reset, provider rate limits, CAPTCHA, session/JWT
  lifetime, and MFA settings. Choose explicit values appropriate to your
  organization; do not assume local Supabase defaults are production settings.
- Review and test the email templates after setting the public Site URL.

If Google sign-in is enabled, create a Google **Web application** client. In
Google Auth Platform, add the Supabase callback shown on the Supabase Google
provider page (normally
`https://<project-ref>.supabase.co/auth/v1/callback`) as the authorized
redirect URI. Enter that client ID and secret in Supabase's Google provider
settings. Keep the Google consent audience and scopes limited to the features
you offer. This provider callback is different from Vaultr's frontend callback.
See WS7-D-01 and WS7-H-01.

Before running schema SQL, open a single Supabase SQL Editor session and check
the effective role:

```sql
select session_user, current_user;
```

For DDL, `current_user` must be `postgres`. If it is not, use only a verified
privileged path that can switch to `postgres`, then repeat the check. Do not
change provider default privileges to work around the wrong migration role.

For a genuinely fresh project, apply `backend/schema.sql`. For an existing
database, take a backup, identify the last applied migration, and apply each
newer file in `backend/migrations/` in filename order. Do not run the full fresh
schema over production data or skip a migration. Record the last migration
filename with the release.

Have the database owner compare the deployed security state with the current
schema and migrations: RLS and FORCE RLS, policies, grants, table owners,
default privileges, functions, triggers, and extensions. These read-only
queries help inventory public-table policy and role grants:

```sql
SELECT n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
ORDER BY c.relname;

SELECT grantee, table_schema, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee IN ('anon', 'authenticated', 'service_role')
ORDER BY table_name, grantee, privilege_type;

SELECT r.rolname, d.defaclnamespace::regnamespace, d.defaclobjtype, d.defaclacl
FROM pg_default_acl d JOIN pg_roles r ON r.oid = d.defaclrole
ORDER BY r.rolname, d.defaclnamespace::regnamespace::text, d.defaclobjtype;
```

The backend uses a server-side service-role client that bypasses RLS, so
application authorization and a protected service key remain essential.
Restrict database network access
to the application host where the provider supports it. Confirm backup/PITR
retention and test a restore into a separate staging project. See WS7-D-02,
WS7-D-03, and WS7-J-01.

If Word handoff is enabled, apply
`20260825_01_auth_handoff_tickets.sql` before enabling that flow. If the
deployed release requires any later migration, apply it before directing users
to that release.

## 3. Lock down object storage

Create a private bucket. In the storage dashboard:

- Disable anonymous/public bucket access and public object ACLs.
- Turn on the provider's encryption-at-rest setting.
- Create an application token restricted to this bucket and the object
  operations the service needs. Do not use an account administrator key.
- Copy the provider's S3 API endpoint into `R2_ENDPOINT_URL`. It must use
  HTTPS and support the path-style addressing used by the backend. Do not use
  a local hostname or an internal Docker name in a browser-facing signed URL.
- Set `R2_PUBLIC_ENDPOINT_URL` only if a separate HTTPS endpoint is needed for
  browser-signed uploads. Leave it blank otherwise.

Set bucket CORS to the exact web/add-in origins that upload directly. The
application expects `PUT` and `HEAD`, `Content-Type` and `x-amz-*` request
headers, and `ETag` in the response. Adapt this policy by replacing both
example origins with the actual production origins:

```json
[
  {
    "AllowedOrigins": [
      "https://app.your-domain.example",
      "https://word.your-domain.example"
    ],
    "AllowedMethods": ["PUT", "HEAD"],
    "AllowedHeaders": ["Content-Type", "x-amz-*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Do not use `*`. Review lifecycle, versioning, and retention together: staging
and abandoned uploads may expire only after the maximum four-hour upload
session and the processing/retry window; lifecycle rules must not erase sealed
documents or legally retained versions. Decide whether versioning is needed
for recovery and account for noncurrent-version cleanup. In approved staging,
verify signed content type/length and metadata enforcement, 15-minute signed
URL expiry, download response overrides, replay behavior, copy/read-after-write,
and overwrite semantics using a tiny synthetic object. Emulator results do not
prove hosted provider behavior. See WS7-E-01 through WS7-E-04 and WS7-J-02.

## 4. Create and protect runtime secrets

Use a secrets manager owned by the organization. Limit read access to the
deployment service and named operators. Keep a protected, encrypted recovery
copy for persistent signing and encryption keys. Generate each application key
separately; do not reuse one key for different purposes. For random 32-byte
hex keys, use `openssl rand -hex 32` in a private terminal and put the result
directly into the secret manager. Never paste secret values into tickets,
chat, screenshots, build logs, or this guide.

Copy `.env.production.example` to the repository root as `.env.production` only
on the production host, or transfer the entries into the host's secret manager.
Set the file readable only by the deployment account (`chmod 600`). This file
is ignored by Git. Do not stage it, upload it as a build artifact, or pass
secret values as Docker build arguments. Compose reads the file for
interpolation only when you pass `--env-file .env.production`.

Use these sources and keep each value private:

| Setting | Where it comes from |
| --- | --- |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | Supabase project API settings; the publishable key is not a service credential, but keep it in the server config for consistency. |
| `SUPABASE_SECRET_KEY` | Supabase secret service-role key; backend only. |
| `JWT_SECRET` | Copy the JWT signing secret for this Supabase project into the backend secret store. Keep it separate from the service-role key. |
| `DOWNLOAD_SIGNING_SECRET` | Generate an independent 32-byte random hex key; changing it invalidates existing application download tokens. |
| `USER_API_KEYS_ENCRYPTION_SECRET` | Generate an independent 32-byte random hex key; back it up securely because stored user provider keys depend on it. |
| `MCP_CONNECTORS_ENCRYPTION_SECRET` | Generate an independent 32-byte random hex key for connector/OAuth data; do not reuse the user-key key. |
| `AUTH_HANDOFF_ENCRYPTION_SECRET` | Generate an independent 32-byte random hex key when the Word add-in is configured. |
| `REDIS_PASSWORD` | Generate a URL-safe random value, for example 32 random bytes in hex; keep it in the same private store as `REDIS_URL`. |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Create a restricted storage token for this bucket in the provider dashboard. |
| Google, Slack, or other `*_OAUTH_CLIENT_SECRET` values | The corresponding identity-provider console; add only when enabling that integration. |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, router keys, and `COURTLISTENER_API_TOKEN` | The provider's account dashboard; optional server-side credentials only. User-supplied keys are stored encrypted by the application. |
| `MANIFEST_SIGNING_KEY` | Optional 32-byte Ed25519 seed as 64 hex characters; generate separately and keep its recovery copy protected. |
| `SPOTLIGHT_NONCE_SECRET` | Optional independent random key; blank uses the download-signing key. |
| Sentry DSNs | The approved Sentry project. A DSN is a reporting destination identifier, not an API secret; never place a Sentry auth token in runtime variables. |

Set `FRONTEND_URL`, `WORD_ADDIN_URL`, `API_PUBLIC_URL`, `APP_HOST`, and
`WORD_HOST` to exact production addresses. `API_PUBLIC_URL` includes `/api`.
Set `ALLOWED_ORIGINS` to the exact browser origins separated by commas. Keep
`TRUST_PROXY_HOPS=1` only when the bundled path is Caddy → frontend/Word proxy
→ backend and no CDN sits in front of Caddy. `API_REPLICAS` may be greater
than one only when all API replicas use the same shared Redis. Leave diagnostic
flags disabled. Add only exact, reviewed private model endpoint origins to
`MODEL_PRIVATE_ENDPOINT_ALLOWLIST`; never add broad ranges, loopback, link
local, or metadata endpoints.

The Compose template builds browser Sentry DSNs into the public web/add-in
bundles. DSNs are not credentials, but provider API keys, Supabase service
keys, storage keys, OAuth secrets, and signing/encryption keys must never be
placed in `NEXT_PUBLIC_*` or `REACT_APP_*` variables. The optional Sentry
source-map upload token is a build-only secret and is not part of the runtime
template.

Back up the encryption keys independently from database backups. Restoring a
database without its matching encryption keys can make stored provider keys
and OAuth credentials unreadable. Plan rotations with re-encryption/recovery;
do not simply replace a key while ciphertext still depends on it. See
WS7-F-01 and WS7-F-02.

## 5. Configure Caddy and verify the trust boundary

The supplied Caddy template redirects HTTP to HTTPS and serves the web app and
Word add-in on separate hostnames. It sets HSTS, `X-Content-Type-Options`,
`Referrer-Policy`, `Permissions-Policy`, and app framing protection. It leaves
the web app's per-response nonce CSP intact and applies a separate Word add-in
CSP that permits Office.js and the required Office frame ancestors. Add only
exact HTTPS telemetry origins to `WORD_ADDIN_CSP_CONNECT_ORIGINS`.

Caddy replaces `X-Forwarded-For` with the connection's remote address and
strips `X-Real-IP`, `Forwarded`, `CF-Connecting-IP`, and `True-Client-IP`.
The frontend gateway preserves Caddy's value to Express, so set
`TRUST_PROXY_HOPS=1`. Do not expose the backend port directly. If a CDN or
another proxy is added, stop and document the full chain, trusted address
source, forwarding rewrite, and Express hop count before deployment; the
current template deliberately does not trust CDN headers.

The proxy body caps match application parsers: 256 KiB for upload-session
control requests, 1 MiB for general JSON, and 2 MiB for chat/Tabular requests.
Direct file bytes go to signed object storage URLs. Streaming responses are
not buffered and have bounded idle/total timeouts. Keep Caddy's configured
limits and application parser limits in sync when changing either.

The frontend, backend, and add-in also set application-level CSP or security
headers. HSTS applies on HTTPS responses; the port-80 site only redirects.
The production API uses exact credentialed CORS origins and trusted-Origin
checks for state changes. Web cookies are Secure, HttpOnly, SameSite=Lax and
`__Host-` prefixed; Word task-pane cookies are Secure, HttpOnly,
SameSite=None, and Partitioned. Confirm these in the real browser and hosting
response, not from source code alone. See WS7-A-01 through WS7-A-03 and
WS7-G-01 through WS7-G-03.

## 6. Set monitoring, integrations, and recovery

Choose an error-reporting destination or an equivalent monitored log service.
Review Sentry's event scrubbing, retention, member access, alert routing, and
integrations before sending production errors. The application filters event
content in code, but this repository cannot inspect account retention or who
can view the project. If you disable Sentry, make sure the replacement alert
path is tested. See WS7-I-01 and WS7-I-02.

Before enabling integrations, create production OAuth clients and verify their
exact redirect URLs, consent status, requested scopes, and revocation path.
Drive uses read-only access; Gmail and Calendar begin read-only, and any write
scope requires a deliberate approval. MCP and CourtListener credentials must
be scoped to the feature and held server-side. Treat document text, workflow
instructions, model output, external search results, and MCP responses as
untrusted data. See WS7-G-03 and WS7-H-01 through WS7-H-03.

Set database backups/PITR and object-storage lifecycle/versioning to match the
organization's retention policy. Rehearse a database restore to a separate
project and restore synthetic objects plus the matching encryption keys before
launch. Record who can perform recovery and how long it takes. A configured
backup without a successful restore rehearsal is not a passed recovery gate.
See WS7-J-01 and WS7-J-02.

In GitHub, protect `main`: require pull requests and review, required CI checks,
and block force-push/deletion. Enable secret scanning, CodeQL, dependency
alerts/Dependabot, and least-privilege Actions permissions. Require organization
MFA, restrict deployment credentials, and retain image build/provenance
records. These account-level controls are outside the repository's local
verification. See WS7-K-01 through WS7-K-03.

Set provider spend alerts and explicit budgets for model usage, queue depth,
storage, and stream time. Request-rate limits do not cap total provider spend
or stored bytes. Confirm the deployment has no local/demo credentials, local
HTTP URLs, open local signup settings, or test routes. See WS7-B-01,
WS7-B-02, WS7-C-01, WS7-C-02, WS7-N-01, and WS7-N-02.

## 7. Fill the production environment and start a release

Review every variable in [`deploy/.env.production.example`](../deploy/.env.production.example).
Required secrets and public URLs must be filled; blank optional integration
values stay disabled. `R2_ENDPOINT_URL`, `SUPABASE_URL`, and public application
URLs must use HTTPS. `SENTRY_ENABLE_TEST_ROUTE`, raw model logging, and debug
flags must remain false/zero. Use the supplied Redis password and keep Redis
private. The template's Redis URL is authenticated plaintext on the private
same-host Docker network; a separate Redis provider must use its TLS endpoint.

The production startup guard checks configuration before the API listens or a
standalone worker starts. It stops the process for checked-in demo/default
secrets, missing or short keys, reused service/publishable keys, invalid URLs
or origins, insecure public endpoints, missing proxy-hop declaration,
unbounded/disabled rate limits, enabled debug/test flags, or broad, link-local,
or metadata model-address entries. It prints variable names and rules only,
never secret values. It warns once when Redis is missing, or when a
non-loopback Redis URL has neither authentication nor TLS; it also warns about
missing error reporting, a missing separate connector encryption key, and
multiple API replicas without shared Redis. Resolve warnings or document an
approved compensating control before launch.

Run commands from the repository root on the production host. First check the
Compose interpolation without printing the resolved secret-bearing config:

```sh
docker compose --project-directory . --env-file .env.production \
  -f deploy/docker-compose.prod.yml config --quiet
```

Build and start the reviewed release only after migrations, secrets, firewall,
and storage policy are ready:

```sh
docker compose --project-directory . --env-file .env.production \
  -f deploy/docker-compose.prod.yml up --build -d
```

The `--project-directory .` option keeps build contexts and the Caddy file
mount rooted at the repository. Keep the resolved Compose output private; it
contains interpolated configuration. Confirm health checks, Caddy certificate
issuance, app/API reachability, worker health, Redis persistence, and useful
alerts from the real provider dashboards.

## 8. Run the read-only pre-launch probes

All network scripts are dry-run by default and print `MANUAL` without making a
request. To send a live probe, use both `--run` and `--i-own-this-target` and
only supply a hostname/account you control. The scripts use no credentials.
They reject literal or DNS-resolved loopback targets. The forwarded-IP check
makes four GET requests to `/api/health`; this creates only short-lived rate
limiter counters, not user records. Run it from a trusted external network.

```sh
node scripts/ws7-verify/tls-and-redirect.mjs https://app.your-domain.example
node scripts/ws7-verify/tls-and-redirect.mjs https://app.your-domain.example --run --i-own-this-target

node scripts/ws7-verify/security-headers-and-cors.mjs \
  https://app.your-domain.example https://app.your-domain.example/api
node scripts/ws7-verify/security-headers-and-cors.mjs \
  https://app.your-domain.example https://app.your-domain.example/api \
  --run --i-own-this-target

node scripts/ws7-verify/forwarded-ip-trust.mjs https://app.your-domain.example
node scripts/ws7-verify/forwarded-ip-trust.mjs \
  https://app.your-domain.example --run --i-own-this-target

node scripts/ws7-verify/direct-backend-reachability.mjs backend.example.net:3001
node scripts/ws7-verify/direct-backend-reachability.mjs \
  backend.example.net:3001 --run --i-own-this-target

node scripts/ws7-verify/public-bucket.mjs https://storage.example.net/private-bucket \
  --object https://storage.example.net/private-bucket/synthetic-canary.txt
node scripts/ws7-verify/public-bucket.mjs https://storage.example.net/private-bucket \
  --object https://storage.example.net/private-bucket/synthetic-canary.txt \
  --run --i-own-this-target

node scripts/ws7-verify/manual-checklist.mjs vaultr-production
```

The TLS script checks the public certificate and HTTP redirect; it uses the
local `openssl` executable for bounded TLS 1.0/1.1 negotiation probes. If the
local OpenSSL build cannot test those versions, the script reports `MANUAL`;
complete the protocol check from an approved machine. Run the direct-backend
probe from a network outside the host/provider network. For the public-bucket
probe, use a known synthetic object URL on the same public endpoint; `401` or
`403` denies anonymous access, `404` is inconclusive, and any `2xx` is a fail.
The manual checklist prints all 35 dashboard-only checks with their facts
report IDs. A script pass is evidence from that one probe only; it does not
replace account review or restore testing.

## 9. Launch gate checklist

Mark every box before inviting a user or adding client data. If an optional
feature is not used, confirm it is disabled and record that decision.

- [ ] **Ingress and service layout** — WS7-A-01–A-04: Caddy is the only public app listener; forwarded headers and proxy count are verified; admin and internal ports are restricted.
- [ ] **Processes and Redis** — WS7-B-01–B-02, C-01–C-02: replicas share authenticated Redis; worker mode, persistence, memory policy, failover, and alerts are verified.
- [ ] **Supabase** — WS7-D-01–D-03: Auth settings, PostgreSQL creator role, RLS/grants/default ACLs, migration order, backups, and network restrictions are checked.
- [ ] **Object storage** — WS7-E-01–E-04: private bucket, least-privilege token, exact CORS, HTTPS endpoint, signature/expiry tests, copy/replay behavior, lifecycle, and versioning are checked.
- [ ] **Secrets and environments** — WS7-F-01–F-03: unique keys are in a secret manager, recovery is tested, production and staging do not share credentials or data.
- [ ] **Browser and redirects** — WS7-G-01–G-03: cookie flags, CSRF/CORS, CSP/HSTS/frame headers, production origins, and OAuth redirects are verified in a browser.
- [ ] **OAuth integrations** — WS7-H-01–H-03: consent status, client callbacks, least scopes, credential storage, and disconnect/revocation are checked for every enabled integration.
- [ ] **Logs and alerts** — WS7-I-01–I-02: scrubbing, access, retention, alert routing, and an error alert are verified.
- [ ] **Recovery** — WS7-J-01–J-02: database restore, object restore, and matching encryption-key recovery have been rehearsed outside production.
- [ ] **GitHub and release** — WS7-K-01–K-03: `main` protection, CI/security scans, Actions permissions, MFA, deploy tokens, and image provenance are checked.
- [ ] **Egress and capacity** — WS7-L-01, M-01, N-01: outbound destinations, BYO/private endpoint defenses, spend, queue, storage, and stream budgets are approved.
- [ ] **Production values and probes** — WS7-N-02: demo/local values are absent; all applicable scripts and dashboard checks have recorded results.

Owner: ____________________  Release/commit: ____________________

Date: ____________________  Approval record: ____________________

## 10. Facts report ID index

Use these identifiers in the checklist, deployment record, and follow-up work.

| ID | Owner check |
| --- | --- |
| WS7-A-01 | Forwarded-IP rewrite and `TRUST_PROXY_HOPS` |
| WS7-A-02 | Backend listener private behind proxy |
| WS7-A-03 | TLS, redirect, certificate, and HSTS |
| WS7-A-04 | Firewall and administrator paths |
| WS7-B-01 | API replica count and shared rate-limit counters |
| WS7-B-02 | Worker count, mode, and concurrency |
| WS7-C-01 | Private, authenticated Redis; TLS for remote endpoint |
| WS7-C-02 | Redis persistence, eviction, failover, and alerts |
| WS7-D-01 | Supabase Auth policy and email delivery |
| WS7-D-02 | Service key, grants, RLS, policies, and default privileges |
| WS7-D-03 | Migration history, extensions, database access, and recovery |
| WS7-E-01 | Bucket public access, policy, credentials, and encryption |
| WS7-E-02 | Storage CORS, endpoint, addressing, and TLS |
| WS7-E-03 | Signed headers, expiry, and download response overrides |
| WS7-E-04 | Upload replay, copy, versioning, and lifecycle |
| WS7-F-01 | Secret access, audit trail, and rotation |
| WS7-F-02 | Encryption-key backup and safe rotation |
| WS7-F-03 | Staging/production separation |
| WS7-G-01 | Cookie flags, CORS, and CSRF |
| WS7-G-02 | CSP, HSTS, and response security headers |
| WS7-G-03 | Production origins and callback URLs |
| WS7-H-01 | Google sign-in consent and client |
| WS7-H-02 | Drive, Gmail, and Calendar scopes |
| WS7-H-03 | MCP and CourtListener credentials |
| WS7-I-01 | Sentry destination, scrubbing, retention, and access |
| WS7-I-02 | Logs, alerting, and access |
| WS7-J-01 | Database backup/PITR and restore rehearsal |
| WS7-J-02 | Object and secret recovery |
| WS7-K-01 | Main branch rules and review |
| WS7-K-02 | Code scanning, secret scanning, and dependency updates |
| WS7-K-03 | Actions permissions, MFA, deploy tokens, and image provenance |
| WS7-L-01 | Outbound restrictions for local model services |
| WS7-M-01 | Custom endpoint protection against private and metadata destinations |
| WS7-N-01 | Spend, queue, storage, and stream budgets |
| WS7-N-02 | No local/demo settings in production |

## After every infrastructure change

Repeat the affected checks after a DNS, firewall, CDN, proxy, TLS, certificate,
Supabase, migration, bucket, CORS, lifecycle, versioning, Redis, OAuth,
secret-manager, model-endpoint, Sentry, GitHub, or image change. Reconfirm the
forwarded header path and proxy hop count, rerun the relevant read-only script,
and record the result against the WS7 ID. Rehearse restores after changes to
backup or key handling. Do not treat a previously passing local test as proof
of the changed hosted configuration.

## Deployment verification status

This guide and its scripts are prepared from repository code, local tests, and
the owner facts checklist. They do not connect to or certify any live system.
No production account, hosted bucket, or production credential was available
for this work. Every account-side check above remains a pre-launch gate for the
owner to complete and record before real users or client data are involved.
