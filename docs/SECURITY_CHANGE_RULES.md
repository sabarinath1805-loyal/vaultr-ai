# Security change rules

Use this checklist for every code, dependency, migration, deployment, and
test-harness change that can affect a security boundary. These rules preserve
the contracts in [SECURITY_BASELINE.md](SECURITY_BASELINE.md).

## Required review checklist

- [ ] **New HTTP route:** define authentication and current tenant/resource
  authorization, apply the rate-limit class and body limit appropriate to its
  cost and trust boundary, and add the route to the route-coverage tests.
  Include both route aliases when a router is mounted more than once.
- [ ] **New model/server tool:** declare capability metadata and enforce the
  shared current-context authorization boundary before dispatch. Validate
  every model-controlled identifier, parent/child combination, and external
  side effect independently.
- [ ] **New outbound request:** use the guarded outbound HTTP helper or the
  guarded MCP transport. Add a controlled loopback fake, cover redirects,
  private destinations, response bounds, timeouts, and credential handling,
  and pass the default-on network guard. Do not add a test opt-out.
- [ ] **Security-relevant environment variable:** add validation or a
  redacted warning to the production startup guard, document it in the
  production template and setup guide, and add template/guard tests.
- [ ] **Database migration or object:** preserve owner, RLS, grants,
  default-privilege hardening, function security mode, and safe `search_path`.
  Update the fresh schema and prove both fresh-install and ordered-upgrade
  convergence with the supported schema tests.
- [ ] **Provider or deployment setting:** update the production launch gates
  with an owner-verifiable check. Local emulator results must not be described
  as proof of hosted-provider behavior.
- [ ] **Test change:** never delete or weaken a failing security test to get a
  green result. Fix the behavior or test fixture, keep the normal authorized
  control, and add the regression to the pinned membership manifest when it
  follows the security-test naming convention.
- [ ] **Before every push:** run `npm run test:security` from the repository
  root and report its exact pass, fail, and skip counts. Run any additional
  subsystem gates required by the change.
- [ ] **Copied or vendored code:** verify that its license is compatible with
  this AGPL-3.0 project, keep the required copyright/license/attribution
  notices, and review the code against the trust boundaries and contracts in
  the security baseline. Do not copy unknown-license code without owner/legal
  review.
- [ ] **Secrets and audit evidence:** do not commit credentials, real
  environment files, signed URLs, client data, logs, scanner output, or
  synthetic evidence. Keep the private ignored `audit.md` out of Git staging.

## Review and release

Security tests must run with the default-on egress guard. The test suite may
use local loopback fakes and documented disposable local services; it must not
silently reach real providers. A new finding must have a reproducible
attacker-controlled path and a normal authorized control. If deployment
evidence is needed, name the exact owner-side check and keep it separate from
local code results.

Do not publish a baseline tag until the required backend, frontend, Word,
stack, and full-suite gates pass, the working tree is clean, and the commits
contain no private audit artifact or credentials.
