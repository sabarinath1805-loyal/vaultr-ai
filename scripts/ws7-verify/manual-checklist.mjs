import { pathToFileURL } from "node:url";
import { oneLineResult } from "./common.mjs";

export const MANUAL_ITEMS = [
  ["WS7-A-01", "Ingress/CDN: remove client forwarding headers and confirm the trusted proxy hop count."],
  ["WS7-A-02", "Hosting firewall: allow backend traffic only from the frontend or proxy network."],
  ["WS7-A-03", "DNS/TLS dashboard: check HTTPS, HTTP redirect, certificate renewal and HSTS for every public host."],
  ["WS7-A-04", "Cloud firewall/admin console: restrict SSH, database, Redis and administrator access; require MFA and logs."],
  ["WS7-B-01", "API hosting: record replica/autoscaling limits and confirm every replica uses the same Redis."],
  ["WS7-B-02", "Worker hosting: confirm API embedded workers are disabled when a separate worker service runs."],
  ["WS7-C-01", "Redis provider: require authentication and TLS, private ingress and a dedicated application user."],
  ["WS7-C-02", "Redis provider: check persistence, memory policy, failover, alerts and recovery behavior."],
  ["WS7-D-01", "Supabase Auth: review signup, email confirmation, CAPTCHA, password, reset, MFA and session settings."],
  ["WS7-D-02", "Supabase SQL/editor: verify service role, RLS, policies, grants and default privileges after migrations."],
  ["WS7-D-03", "Supabase database: verify migration history, extensions, network rules, PITR and recovery owner."],
  ["WS7-E-01", "R2/S3 bucket: block public access, review least-privilege credentials and encryption-at-rest settings."],
  ["WS7-E-02", "R2/S3 dashboard: verify exact CORS origins, endpoint, addressing mode and TLS behavior."],
  ["WS7-E-03", "R2/S3 signing: verify signed headers, metadata enforcement, expiry and download response overrides."],
  ["WS7-E-04", "R2/S3 lifecycle: test replay cleanup, copy/overwrite semantics, versioning and retention."],
  ["WS7-F-01", "Secret manager: restrict secret readers, enable access logs and confirm rotation history."],
  ["WS7-F-02", "Secret manager/backup: rehearse encryption-key backup and rotation without losing stored credentials."],
  ["WS7-F-03", "Hosting environments: confirm staging and production have separate projects, buckets and secrets."],
  ["WS7-G-01", "Browser/API settings: verify Secure, HttpOnly and SameSite cookies, exact CORS origins and CSRF controls."],
  ["WS7-G-02", "Edge and application response: check CSP, HSTS, frame protections and other security headers."],
  ["WS7-G-03", "Supabase/OAuth dashboards: verify production origins, callback URLs and allowed redirects."],
  ["WS7-H-01", "Google Cloud OAuth: review consent screen, production publishing status, scopes and redirect URI."],
  ["WS7-H-02", "Google Workspace: confirm Drive/Gmail/Calendar scopes and the approved user-facing consent."],
  ["WS7-H-03", "MCP and CourtListener settings: confirm connector ownership, exact callback URLs and credential scopes."],
  ["WS7-I-01", "Sentry project: confirm destination, event scrubbing, retention, member access and integrations."],
  ["WS7-I-02", "Log/alert provider: verify sensitive-value redaction, retention, access and actionable security alerts."],
  ["WS7-J-01", "Supabase dashboard: confirm backup/PITR retention and complete a restore rehearsal to a separate project."],
  ["WS7-J-02", "Object storage/secret manager: rehearse object recovery and encryption-key recovery together."],
  ["WS7-K-01", "GitHub repository rules: require reviewed protected-main changes and required checks."],
  ["WS7-K-02", "GitHub Security: enable secret scanning, CodeQL, dependency alerts and Dependabot updates."],
  ["WS7-K-03", "GitHub Actions/org settings: restrict workflow permissions, require MFA, rotate deploy tokens and verify image provenance."],
  ["WS7-L-01", "Hosting egress/firewall: limit outbound access for local model services to approved destinations."],
  ["WS7-M-01", "BYO endpoint/egress policy: block loopback, private infrastructure and cloud metadata destinations."],
  ["WS7-N-01", "Provider dashboards: set spend alerts, queue limits, storage quotas and stream-duration budgets."],
  ["WS7-N-02", "Production release review: compare runtime config and image contents against local/demo defaults."],
];

export function formatManualChecklist(deploymentLabel) {
  const label = String(deploymentLabel ?? "").trim();
  if (!label) return [oneLineResult("FAIL", "provide a deployment label; this checklist never connects to a host")];
  return [
    oneLineResult("MANUAL", `dashboard checklist for ${label}; no network connection or account change was made`),
    ...MANUAL_ITEMS.map(([id, instruction]) => oneLineResult("MANUAL", `${id}: ${instruction}`)),
  ];
}

function main() {
  for (const line of formatManualChecklist(process.argv[2])) console.log(line);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
