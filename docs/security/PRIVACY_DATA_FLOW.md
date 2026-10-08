# Privacy and data flow — 8 October 2026

Source-grounded assessment; deployment-specific behavior is Not Verified. Public legal/privacy policies were not changed.

| Stage | Data and destination | Controls / limitations |
| --- | --- | --- |
| Browser/Word | Selected documents, edits, chats, auth sessions | Sanitized rendering/URLs; live Office consent/storage behavior not verified. Browser Supabase usage is authentication, not proof of offline document storage. |
| Ingestion | Selected content to backend and configured object storage | Owner/upload completion checks, generated keys and size policies. Provider bucket controls require live verification. |
| Persistence | Configured Supabase database and S3-compatible document objects | Service-role operations rely on server authorization. Source RLS/revocations are not deployed convergence evidence. Encryption at rest is provider-specific. |
| AI | Authorized chat/retrieval/drafting context to selected configured model provider | Resource checks independent of model. Training, retention, residency and subprocessor terms unverified. |
| Connectors | Google Drive/Gmail/Calendar, user MCP peers, legal research | User-scoped encrypted credentials/current permissions; Google writes use explicit expiring proposals. MCP peer annotations cannot prove side effects (ARCH-001). |
| Temporary | API/parser memory, conversion temporary files, optional Redis/queue/cache | Office expansion admission added; not an RSS/CPU ceiling. Cleanup and process-local quota fallbacks require deployed verification. |
| Logs | Console and optional Sentry | Examined central 5xx boundaries now use opaque categories/redacted route patterns; Sentry has scrubbers. Other logs and collector retention/access still require review. |
| Downloads/exports | Signed URLs and generated exports | Source URL TTL 900 seconds; bearer access remains until expiry unless provider revocation intervenes. Export cleanup scheduling is not proof of live deletion. |
| Deletion/backups | DB/storage lifecycle and cleanup jobs; provider backups | Mock deletion tests pass. Deletion completeness, restore, retention and downstream erasure unverified. |

Source anchors: backend/src/modules/uploads, backend/src/modules/documents, backend/src/lib/mcp, backend/src/modules/chat/engine, backend/src/modules/integrations, backend/src/lib/observability/sentry.ts and schema.sql. See inventory/findings for concrete boundaries.

Suggested wording for owner review: “Vaultr uses local interaction and configured services. Selected document and chat content may be sent to configured storage, AI providers and enabled connectors to perform requested workflows. Retention and residency depend on those services and deployment settings.” This is a recommendation, not a verified legal commitment.

A limited tracked-file credential-pattern scan identified test/config fixtures only; no real credential identified. Full-history secret scanning was not executed. This does not establish secret-free history. No credential values appear here.
