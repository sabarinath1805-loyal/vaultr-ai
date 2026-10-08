# Attack surface inventory — 8 October 2026

Static TypeScript AST source inventory, including expanded aliases/provider and decision variants: 266 mounted HTTP method/path entries; 251 have visible auth middleware. The flag is evidence, not authorization proof. Public login/session/OAuth routes require their own state, cookie and handoff controls.

| Surface | Review boundary |
| --- | --- |
| Express | Auth/session/users/orgs/projects, documents/uploads/downloads/versions, chat/Word chat, models, search/research/citations, memory, audit/export, integrations; object checks beyond route auth |
| Public handlers | Health, manifest public key, state-bound callbacks and session/reset/handoff; optional production-gated Sentry test, retired multipart handler |
| Frontend | Next API proxy/SSE, Markdown/HTML/DOCX rendering, CSP, redirects, popup and cache boundaries |
| Word | Office.js document access, handoff, API proxy, manifest/static taskpane; live runtime unverified |
| AI/tools | Capability catalog, dispatcher, citations/retrieval, streaming checks, memory/tabular jobs, Google write proposals, user MCP tools |
| Jobs | Queue registry, cleanup/exports, extraction/sync/memory/tabular; current ownership and bounds |
| Data | Supabase service-role database/schema/RLS/functions, configured S3 and signed URLs, optional Redis |
| External | Selected AI providers, Google Drive/Gmail/Calendar, MCP peers, CourtListener, optional Sentry/email; configured does not mean deployed |
| Build | Four npm lockfile trees, contracts package, workflows/actions, main protection/token defaults |

Default JSON limit 1 MiB; upload manifest 256 KiB; compressed upload 100 MiB. New Office admission separately bounds 128 MiB expanded/10,000 resolved entries. Limits are not complete CPU/RSS protection. Proxy hop assumptions require deployment verification. Direct public handlers above are listed separately from mounted router declarations.

## Mounted routes

| Method | Path | Auth middleware visible | Source |
| --- | --- | --- | --- |
| GET | /audit/ | yes | backend/src/modules/audit/audit.routes.ts:20 |
| GET | /audit/export | yes | backend/src/modules/audit/audit.routes.ts:33 |
| POST | /auth/login | no — route-specific control | backend/src/modules/auth/auth.routes.ts:132 |
| POST | /auth/signup | no — route-specific control | backend/src/modules/auth/auth.routes.ts:146 |
| POST | /auth/oauth | no — route-specific control | backend/src/modules/auth/auth.routes.ts:221 |
| POST | /auth/exchange | no — route-specific control | backend/src/modules/auth/auth.routes.ts:244 |
| POST | /auth/handoff | no — route-specific control | backend/src/modules/auth/auth.routes.ts:277 |
| POST | /auth/password-reset | no — route-specific control | backend/src/modules/auth/auth.routes.ts:326 |
| GET | /auth/session | yes | backend/src/modules/auth/auth.routes.ts:343 |
| POST | /auth/logout | no — route-specific control | backend/src/modules/auth/auth.routes.ts:351 |
| PATCH | /auth/email | yes | backend/src/modules/auth/auth.routes.ts:364 |
| PATCH | /auth/password | yes | backend/src/modules/auth/auth.routes.ts:378 |
| GET | /auth/mfa/factors | yes | backend/src/modules/auth/auth.routes.ts:392 |
| GET | /auth/mfa/assurance | yes | backend/src/modules/auth/auth.routes.ts:400 |
| POST | /auth/mfa/enroll | yes | backend/src/modules/auth/auth.routes.ts:408 |
| POST | /auth/mfa/challenge | yes | backend/src/modules/auth/auth.routes.ts:418 |
| POST | /auth/mfa/verify | yes | backend/src/modules/auth/auth.routes.ts:428 |
| POST | /auth/mfa/challenge-and-verify | yes | backend/src/modules/auth/auth.routes.ts:442 |
| DELETE | /auth/mfa/factors/:factorId | yes | backend/src/modules/auth/auth.routes.ts:455 |
| GET | /chat/ | yes | backend/src/modules/chat/chat.routes.ts:74 |
| POST | /chat/create | yes | backend/src/modules/chat/chat.routes.ts:121 |
| GET | /chat/:chatId | yes | backend/src/modules/chat/chat.routes.ts:141 |
| GET | /chat/:chatId/people | yes | backend/src/modules/chat/chat.routes.ts:170 |
| GET | /chat/:chatId/access | yes | backend/src/modules/chat/chat.routes.ts:186 |
| POST | /chat/:chatId/access | yes | backend/src/modules/chat/chat.routes.ts:217 |
| DELETE | /chat/:chatId/access/:email | yes | backend/src/modules/chat/chat.routes.ts:261 |
| PATCH | /chat/:chatId | yes | backend/src/modules/chat/chat.routes.ts:289 |
| DELETE | /chat/:chatId | yes | backend/src/modules/chat/chat.routes.ts:379 |
| POST | /chat/:chatId/generate-title | yes | backend/src/modules/chat/chat.routes.ts:401 |
| POST | /chat/ | yes | backend/src/modules/chat/chat.routes.ts:445 |
| GET | /single-documents/ | yes | backend/src/modules/documents/documents.routes.ts:38 |
| GET | /single-documents/:documentId | yes | backend/src/modules/documents/documents.routes.ts:49 |
| DELETE | /single-documents/:documentId | yes | backend/src/modules/documents/documents.routes.ts:66 |
| GET | /single-documents/:documentId/display | yes | backend/src/modules/documents/documents.routes.ts:85 |
| GET | /single-documents/:documentId/file | yes | backend/src/modules/documents/documents.routes.ts:115 |
| POST | /single-documents/download-zip | yes | backend/src/modules/documents/documents.routes.ts:155 |
| GET | /single-documents/:documentId/url | yes | backend/src/modules/documents/documents.routes.ts:225 |
| GET | /single-documents/:documentId/versions | yes | backend/src/modules/documents/documents.routes.ts:250 |
| POST | /single-documents/:documentId/versions/from-document | yes | backend/src/modules/documents/documents.routes.ts:269 |
| PATCH | /single-documents/:documentId/versions/:versionId | yes | backend/src/modules/documents/documents.routes.ts:331 |
| DELETE | /single-documents/:documentId/versions/:versionId | yes | backend/src/modules/documents/documents.routes.ts:361 |
| GET | /single-documents/:documentId/tracked-change-ids | yes | backend/src/modules/documents/documents.routes.ts:398 |
| POST | /single-documents/:documentId/edits/:editId/accept | yes | backend/src/modules/documents/documents.routes.ts:451 |
| POST | /single-documents/:documentId/edits/:editId/reject | yes | backend/src/modules/documents/documents.routes.ts:457 |
| GET | /download/:token | yes | backend/src/modules/downloads/downloads.routes.ts:16 |
| GET | /library/:kind | yes | backend/src/modules/library/library.routes.ts:90 |
| POST | /library/:kind/levels | yes | backend/src/modules/library/library.routes.ts:125 |
| GET | /library/:kind/filter-options | yes | backend/src/modules/library/library.routes.ts:162 |
| GET | /library/:kind/ids | yes | backend/src/modules/library/library.routes.ts:176 |
| POST | /library/:kind/documents/bulk-delete | yes | backend/src/modules/library/library.routes.ts:193 |
| GET | /library/:kind/folders/:folderId | yes | backend/src/modules/library/library.routes.ts:218 |
| POST | /library/:kind/folder-paths/resolve | yes | backend/src/modules/library/library.routes.ts:233 |
| POST | /library/:kind/folders | yes | backend/src/modules/library/library.routes.ts:254 |
| PATCH | /library/:kind/folders/:folderId | yes | backend/src/modules/library/library.routes.ts:268 |
| DELETE | /library/:kind/folders/:folderId | yes | backend/src/modules/library/library.routes.ts:283 |
| PATCH | /library/:kind/documents/:documentId/folder | yes | backend/src/modules/library/library.routes.ts:297 |
| PATCH | /library/:kind/documents/:documentId | yes | backend/src/modules/library/library.routes.ts:316 |
| GET | /models/ollama | yes | backend/src/modules/models/models.routes.ts:58 |
| GET | /models/configured | yes | backend/src/modules/models/models.routes.ts:63 |
| GET | /models/openrouter | yes | backend/src/modules/models/models.routes.ts:70 |
| GET | /models/vercel | yes | backend/src/modules/models/models.routes.ts:75 |
| GET | /models/opencode-go | yes | backend/src/modules/models/models.routes.ts:80 |
| GET | /orgs/ | yes | backend/src/modules/orgs/orgs.routes.ts:37 |
| POST | /orgs/ | yes | backend/src/modules/orgs/orgs.routes.ts:46 |
| GET | /orgs/:orgId | yes | backend/src/modules/orgs/orgs.routes.ts:55 |
| PATCH | /orgs/:orgId | yes | backend/src/modules/orgs/orgs.routes.ts:64 |
| DELETE | /orgs/:orgId | yes | backend/src/modules/orgs/orgs.routes.ts:78 |
| GET | /orgs/:orgId/resources | yes | backend/src/modules/orgs/orgs.routes.ts:93 |
| GET | /orgs/:orgId/members | yes | backend/src/modules/orgs/orgs.routes.ts:108 |
| PATCH | /orgs/:orgId/members/:userId | yes | backend/src/modules/orgs/orgs.routes.ts:117 |
| DELETE | /orgs/:orgId/members/:userId | yes | backend/src/modules/orgs/orgs.routes.ts:132 |
| POST | /orgs/:orgId/invitations | yes | backend/src/modules/orgs/orgs.routes.ts:150 |
| GET | /orgs/:orgId/invitations | yes | backend/src/modules/orgs/orgs.routes.ts:166 |
| DELETE | /orgs/:orgId/invitations/:invitationId | yes | backend/src/modules/orgs/orgs.routes.ts:178 |
| POST | /orgs/:orgId/invitations/:invitationId/resend | yes | backend/src/modules/orgs/orgs.routes.ts:202 |
| POST | /projects/:projectId/chat/ | yes | backend/src/modules/project-chat/projectChat.routes.ts:58 |
| GET | /projects/ | yes | backend/src/modules/projects/projects.routes.ts:74 |
| POST | /projects/ | yes | backend/src/modules/projects/projects.routes.ts:132 |
| GET | /projects/:projectId/directory | yes | backend/src/modules/projects/projects.routes.ts:171 |
| GET | /projects/filter-options | yes | backend/src/modules/projects/projects.routes.ts:193 |
| GET | /projects/ids | yes | backend/src/modules/projects/projects.routes.ts:207 |
| GET | /projects/:projectId | yes | backend/src/modules/projects/projects.routes.ts:225 |
| GET | /projects/:projectId/people | yes | backend/src/modules/projects/projects.routes.ts:245 |
| GET | /projects/:projectId/access | yes | backend/src/modules/projects/projects.routes.ts:286 |
| POST | /projects/:projectId/access | yes | backend/src/modules/projects/projects.routes.ts:298 |
| DELETE | /projects/:projectId/access/:email | yes | backend/src/modules/projects/projects.routes.ts:315 |
| PATCH | /projects/:projectId | yes | backend/src/modules/projects/projects.routes.ts:336 |
| DELETE | /projects/:projectId | yes | backend/src/modules/projects/projects.routes.ts:368 |
| GET | /projects/:projectId/documents | yes | backend/src/modules/projects/projects.routes.ts:386 |
| GET | /projects/:projectId/export | yes | backend/src/modules/projects/projects.routes.ts:408 |
| POST | /projects/:projectId/documents/:documentId | yes | backend/src/modules/projects/projects.routes.ts:441 |
| PATCH | /projects/:projectId/documents/:documentId | yes | backend/src/modules/projects/projects.routes.ts:491 |
| GET | /projects/:projectId/chats | yes | backend/src/modules/projects/projects.routes.ts:523 |
| POST | /projects/:projectId/folder-paths/resolve | yes | backend/src/modules/projects/projects.routes.ts:541 |
| POST | /projects/:projectId/folders | yes | backend/src/modules/projects/projects.routes.ts:579 |
| PATCH | /projects/:projectId/folders/:folderId | yes | backend/src/modules/projects/projects.routes.ts:607 |
| DELETE | /projects/:projectId/folders/:folderId | yes | backend/src/modules/projects/projects.routes.ts:638 |
| PATCH | /projects/:projectId/documents/:documentId/folder | yes | backend/src/modules/projects/projects.routes.ts:663 |
| GET | /quick-actions/ | yes | backend/src/modules/quick-actions/quickActions.routes.ts:24 |
| POST | /quick-actions/ | yes | backend/src/modules/quick-actions/quickActions.routes.ts:38 |
| PATCH | /quick-actions/:quickActionId | yes | backend/src/modules/quick-actions/quickActions.routes.ts:60 |
| DELETE | /quick-actions/:quickActionId | yes | backend/src/modules/quick-actions/quickActions.routes.ts:77 |
| GET | /documents/:documentId | yes | backend/src/modules/source-documents/sourceDocuments.routes.ts:21 |
| GET | /tabular-review/ | yes | backend/src/modules/tabular/tabular.routes.ts:129 |
| GET | /tabular-review/ids | yes | backend/src/modules/tabular/tabular.routes.ts:148 |
| POST | /tabular-review/ | yes | backend/src/modules/tabular/tabular.routes.ts:162 |
| POST | /tabular-review/prompt | yes | backend/src/modules/tabular/tabular.routes.ts:200 |
| GET | /tabular-review/:reviewId | yes | backend/src/modules/tabular/tabular.routes.ts:218 |
| GET | /tabular-review/:reviewId/people | yes | backend/src/modules/tabular/tabular.routes.ts:232 |
| GET | /tabular-review/:reviewId/access | yes | backend/src/modules/tabular/tabular.routes.ts:243 |
| POST | /tabular-review/:reviewId/access | yes | backend/src/modules/tabular/tabular.routes.ts:254 |
| DELETE | /tabular-review/:reviewId/access/:email | yes | backend/src/modules/tabular/tabular.routes.ts:267 |
| PATCH | /tabular-review/:reviewId | yes | backend/src/modules/tabular/tabular.routes.ts:283 |
| DELETE | /tabular-review/:reviewId | yes | backend/src/modules/tabular/tabular.routes.ts:295 |
| POST | /tabular-review/:reviewId/clear-cells | yes | backend/src/modules/tabular/tabular.routes.ts:308 |
| POST | /tabular-review/:reviewId/regenerate-cell | yes | backend/src/modules/tabular/tabular.routes.ts:325 |
| POST | /tabular-review/:reviewId/generate | yes | backend/src/modules/tabular/tabular.routes.ts:353 |
| GET | /tabular-review/:reviewId/generate/stream | yes | backend/src/modules/tabular/tabular.routes.ts:591 |
| GET | /tabular-review/:reviewId/chats | yes | backend/src/modules/tabular/tabular.routes.ts:619 |
| DELETE | /tabular-review/:reviewId/chats/:chatId | yes | backend/src/modules/tabular/tabular.routes.ts:630 |
| PATCH | /tabular-review/:reviewId/chats/:chatId | yes | backend/src/modules/tabular/tabular.routes.ts:646 |
| GET | /tabular-review/:reviewId/chats/:chatId/messages | yes | backend/src/modules/tabular/tabular.routes.ts:668 |
| POST | /tabular-review/:reviewId/chat | yes | backend/src/modules/tabular/tabular.routes.ts:691 |
| POST | /upload-sessions/ | yes | backend/src/modules/uploads/uploads.routes.ts:76 |
| GET | /upload-sessions/:sessionId | yes | backend/src/modules/uploads/uploads.routes.ts:121 |
| POST | /upload-sessions/:sessionId/urls | yes | backend/src/modules/uploads/uploads.routes.ts:135 |
| POST | /upload-sessions/:sessionId/files/:fileId/complete | yes | backend/src/modules/uploads/uploads.routes.ts:158 |
| DELETE | /upload-sessions/:sessionId | yes | backend/src/modules/uploads/uploads.routes.ts:188 |
| POST | /user/profile | yes | backend/src/modules/user/user.routes.ts:165 |
| POST | /users/profile | yes | backend/src/modules/user/user.routes.ts:165 |
| GET | /user/lookup | yes | backend/src/modules/user/user.routes.ts:174 |
| GET | /users/lookup | yes | backend/src/modules/user/user.routes.ts:174 |
| GET | /user/invitations | yes | backend/src/modules/user/user.routes.ts:195 |
| GET | /users/invitations | yes | backend/src/modules/user/user.routes.ts:195 |
| POST | /user/invitations/:invitationId/accept | yes | backend/src/modules/user/user.routes.ts:204 |
| POST | /users/invitations/:invitationId/accept | yes | backend/src/modules/user/user.routes.ts:204 |
| POST | /user/invitations/:invitationId/decline | yes | backend/src/modules/user/user.routes.ts:222 |
| POST | /users/invitations/:invitationId/decline | yes | backend/src/modules/user/user.routes.ts:222 |
| GET | /user/profile | yes | backend/src/modules/user/user.routes.ts:240 |
| GET | /users/profile | yes | backend/src/modules/user/user.routes.ts:240 |
| PATCH | /user/profile | yes | backend/src/modules/user/user.routes.ts:249 |
| PATCH | /users/profile | yes | backend/src/modules/user/user.routes.ts:249 |
| POST | /user/onboarding | yes | backend/src/modules/user/user.routes.ts:266 |
| POST | /users/onboarding | yes | backend/src/modules/user/user.routes.ts:266 |
| POST | /user/security/password-set | yes | backend/src/modules/user/user.routes.ts:279 |
| POST | /users/security/password-set | yes | backend/src/modules/user/user.routes.ts:279 |
| PATCH | /user/security/mfa-login | yes | backend/src/modules/user/user.routes.ts:292 |
| PATCH | /users/security/mfa-login | yes | backend/src/modules/user/user.routes.ts:292 |
| GET | /user/api-keys | yes | backend/src/modules/user/user.routes.ts:314 |
| GET | /users/api-keys | yes | backend/src/modules/user/user.routes.ts:314 |
| PUT | /user/api-keys/:provider | yes | backend/src/modules/user/user.routes.ts:322 |
| PUT | /users/api-keys/:provider | yes | backend/src/modules/user/user.routes.ts:322 |
| GET | /user/mcp-connectors | yes | backend/src/modules/user/user.routes.ts:346 |
| GET | /users/mcp-connectors | yes | backend/src/modules/user/user.routes.ts:346 |
| GET | /user/mcp-connectors/:connectorId | yes | backend/src/modules/user/user.routes.ts:355 |
| GET | /users/mcp-connectors/:connectorId | yes | backend/src/modules/user/user.routes.ts:355 |
| POST | /user/mcp-connectors | yes | backend/src/modules/user/user.routes.ts:375 |
| POST | /users/mcp-connectors | yes | backend/src/modules/user/user.routes.ts:375 |
| PATCH | /user/mcp-connectors/:connectorId | yes | backend/src/modules/user/user.routes.ts:425 |
| PATCH | /users/mcp-connectors/:connectorId | yes | backend/src/modules/user/user.routes.ts:425 |
| DELETE | /user/mcp-connectors/:connectorId | yes | backend/src/modules/user/user.routes.ts:474 |
| DELETE | /users/mcp-connectors/:connectorId | yes | backend/src/modules/user/user.routes.ts:474 |
| POST | /user/mcp-connectors/:connectorId/oauth/start | yes | backend/src/modules/user/user.routes.ts:492 |
| POST | /users/mcp-connectors/:connectorId/oauth/start | yes | backend/src/modules/user/user.routes.ts:492 |
| GET | /user/mcp-connectors/oauth/callback | no — route-specific control | backend/src/modules/user/user.routes.ts:523 |
| GET | /users/mcp-connectors/oauth/callback | no — route-specific control | backend/src/modules/user/user.routes.ts:523 |
| GET | /user/integrations/google-drive | yes | backend/src/modules/user/user.routes.ts:586 |
| GET | /users/integrations/google-drive | yes | backend/src/modules/user/user.routes.ts:586 |
| POST | /user/integrations/google-drive/oauth/start | yes | backend/src/modules/user/user.routes.ts:613 |
| POST | /users/integrations/google-drive/oauth/start | yes | backend/src/modules/user/user.routes.ts:613 |
| GET | /user/integrations/google-drive/oauth/callback | no — route-specific control | backend/src/modules/user/user.routes.ts:651 |
| GET | /user/integrations/gmail/oauth/callback | no — route-specific control | backend/src/modules/user/user.routes.ts:651 |
| GET | /user/integrations/google-calendar/oauth/callback | no — route-specific control | backend/src/modules/user/user.routes.ts:651 |
| GET | /users/integrations/google-drive/oauth/callback | no — route-specific control | backend/src/modules/user/user.routes.ts:651 |
| GET | /users/integrations/gmail/oauth/callback | no — route-specific control | backend/src/modules/user/user.routes.ts:651 |
| GET | /users/integrations/google-calendar/oauth/callback | no — route-specific control | backend/src/modules/user/user.routes.ts:651 |
| GET | /user/integrations/google-drive/oauth/finish | yes | backend/src/modules/user/user.routes.ts:671 |
| GET | /users/integrations/google-drive/oauth/finish | yes | backend/src/modules/user/user.routes.ts:671 |
| DELETE | /user/integrations/google-drive | yes | backend/src/modules/user/user.routes.ts:719 |
| DELETE | /users/integrations/google-drive | yes | backend/src/modules/user/user.routes.ts:719 |
| POST | /user/integrations/google-drive/oauth/cancel | yes | backend/src/modules/user/user.routes.ts:741 |
| POST | /users/integrations/google-drive/oauth/cancel | yes | backend/src/modules/user/user.routes.ts:741 |
| GET | /user/integrations/gmail | yes | backend/src/modules/user/user.routes.ts:785 |
| GET | /user/integrations/google-calendar | yes | backend/src/modules/user/user.routes.ts:785 |
| GET | /users/integrations/gmail | yes | backend/src/modules/user/user.routes.ts:785 |
| GET | /users/integrations/google-calendar | yes | backend/src/modules/user/user.routes.ts:785 |
| POST | /user/integrations/gmail/oauth/start | yes | backend/src/modules/user/user.routes.ts:809 |
| POST | /user/integrations/google-calendar/oauth/start | yes | backend/src/modules/user/user.routes.ts:809 |
| POST | /users/integrations/gmail/oauth/start | yes | backend/src/modules/user/user.routes.ts:809 |
| POST | /users/integrations/google-calendar/oauth/start | yes | backend/src/modules/user/user.routes.ts:809 |
| GET | /user/integrations/gmail/oauth/finish | yes | backend/src/modules/user/user.routes.ts:836 |
| GET | /user/integrations/google-calendar/oauth/finish | yes | backend/src/modules/user/user.routes.ts:836 |
| GET | /users/integrations/gmail/oauth/finish | yes | backend/src/modules/user/user.routes.ts:836 |
| GET | /users/integrations/google-calendar/oauth/finish | yes | backend/src/modules/user/user.routes.ts:836 |
| POST | /user/integrations/gmail/oauth/cancel | yes | backend/src/modules/user/user.routes.ts:881 |
| POST | /user/integrations/google-calendar/oauth/cancel | yes | backend/src/modules/user/user.routes.ts:881 |
| POST | /users/integrations/gmail/oauth/cancel | yes | backend/src/modules/user/user.routes.ts:881 |
| POST | /users/integrations/google-calendar/oauth/cancel | yes | backend/src/modules/user/user.routes.ts:881 |
| DELETE | /user/integrations/gmail | yes | backend/src/modules/user/user.routes.ts:906 |
| DELETE | /user/integrations/google-calendar | yes | backend/src/modules/user/user.routes.ts:906 |
| DELETE | /users/integrations/gmail | yes | backend/src/modules/user/user.routes.ts:906 |
| DELETE | /users/integrations/google-calendar | yes | backend/src/modules/user/user.routes.ts:906 |
| GET | /user/google-actions | yes | backend/src/modules/user/user.routes.ts:924 |
| GET | /users/google-actions | yes | backend/src/modules/user/user.routes.ts:924 |
| POST | /user/google-actions/:actionId/approve | yes | backend/src/modules/user/user.routes.ts:944 |
| POST | /user/google-actions/:actionId/reject | yes | backend/src/modules/user/user.routes.ts:944 |
| POST | /users/google-actions/:actionId/approve | yes | backend/src/modules/user/user.routes.ts:944 |
| POST | /users/google-actions/:actionId/reject | yes | backend/src/modules/user/user.routes.ts:944 |
| POST | /user/mcp-connectors/:connectorId/refresh-tools | yes | backend/src/modules/user/user.routes.ts:1002 |
| POST | /users/mcp-connectors/:connectorId/refresh-tools | yes | backend/src/modules/user/user.routes.ts:1002 |
| PATCH | /user/mcp-connectors/:connectorId/tools/:toolId | yes | backend/src/modules/user/user.routes.ts:1035 |
| PATCH | /users/mcp-connectors/:connectorId/tools/:toolId | yes | backend/src/modules/user/user.routes.ts:1035 |
| DELETE | /user/account | yes | backend/src/modules/user/user.routes.ts:1062 |
| DELETE | /users/account | yes | backend/src/modules/user/user.routes.ts:1062 |
| DELETE | /user/chats | yes | backend/src/modules/user/user.routes.ts:1087 |
| DELETE | /users/chats | yes | backend/src/modules/user/user.routes.ts:1087 |
| DELETE | /user/projects | yes | backend/src/modules/user/user.routes.ts:1102 |
| DELETE | /users/projects | yes | backend/src/modules/user/user.routes.ts:1102 |
| DELETE | /user/tabular-reviews | yes | backend/src/modules/user/user.routes.ts:1117 |
| DELETE | /users/tabular-reviews | yes | backend/src/modules/user/user.routes.ts:1117 |
| DELETE | /user/memories | yes | backend/src/modules/user/user.routes.ts:1135 |
| DELETE | /users/memories | yes | backend/src/modules/user/user.routes.ts:1135 |
| GET | /user/export | yes | backend/src/modules/user/user.routes.ts:1149 |
| GET | /users/export | yes | backend/src/modules/user/user.routes.ts:1149 |
| GET | /user/chats/export | yes | backend/src/modules/user/user.routes.ts:1176 |
| GET | /users/chats/export | yes | backend/src/modules/user/user.routes.ts:1176 |
| GET | /user/tabular-reviews/export | yes | backend/src/modules/user/user.routes.ts:1203 |
| GET | /users/tabular-reviews/export | yes | backend/src/modules/user/user.routes.ts:1203 |
| POST | /user/exports | yes | backend/src/modules/user/user.routes.ts:1239 |
| POST | /users/exports | yes | backend/src/modules/user/user.routes.ts:1239 |
| GET | /user/exports/:exportId | yes | backend/src/modules/user/user.routes.ts:1286 |
| GET | /users/exports/:exportId | yes | backend/src/modules/user/user.routes.ts:1286 |
| GET | /user/exports/:exportId/download | yes | backend/src/modules/user/user.routes.ts:1308 |
| GET | /users/exports/:exportId/download | yes | backend/src/modules/user/user.routes.ts:1308 |
| GET | /word-chat/ | yes | backend/src/modules/word-chat/wordChat.routes.ts:201 |
| GET | /word-chat/:chatId | yes | backend/src/modules/word-chat/wordChat.routes.ts:229 |
| PATCH | /word-chat/:chatId/model | yes | backend/src/modules/word-chat/wordChat.routes.ts:255 |
| PATCH | /word-chat/:chatId/reasoning | yes | backend/src/modules/word-chat/wordChat.routes.ts:294 |
| PUT | /word-chat/messages/:messageId/edits/:blockIndex | yes | backend/src/modules/word-chat/wordChat.routes.ts:335 |
| PATCH | /word-chat/messages/:messageId/edits/:blockIndex | yes | backend/src/modules/word-chat/wordChat.routes.ts:376 |
| POST | /word-chat/tool-result | yes | backend/src/modules/word-chat/wordChat.routes.ts:478 |
| POST | /word-chat/ | yes | backend/src/modules/word-chat/wordChat.routes.ts:504 |
| GET | /workflow-addons/ | yes | backend/src/modules/workflows/workflowAddons.routes.ts:37 |
| GET | /workflow-addons/:addonId/assets/:assetId/display | yes | backend/src/modules/workflows/workflowAddons.routes.ts:62 |
| GET | /workflow-addons/:addonId | yes | backend/src/modules/workflows/workflowAddons.routes.ts:84 |
| POST | /workflow-addons/:addonId/import | yes | backend/src/modules/workflows/workflowAddons.routes.ts:96 |
| GET | /workflows/ | yes | backend/src/modules/workflows/workflows.routes.ts:106 |
| GET | /workflows/system | yes | backend/src/modules/workflows/workflows.routes.ts:143 |
| GET | /workflows/filter-options | yes | backend/src/modules/workflows/workflows.routes.ts:153 |
| GET | /workflows/ids | yes | backend/src/modules/workflows/workflows.routes.ts:175 |
| POST | /workflows/ | yes | backend/src/modules/workflows/workflows.routes.ts:200 |
| PUT | /workflows/:workflowId | yes | backend/src/modules/workflows/workflows.routes.ts:264 |
| PATCH | /workflows/:workflowId | yes | backend/src/modules/workflows/workflows.routes.ts:267 |
| DELETE | /workflows/:workflowId | yes | backend/src/modules/workflows/workflows.routes.ts:270 |
| GET | /workflows/hidden | yes | backend/src/modules/workflows/workflows.routes.ts:290 |
| POST | /workflows/hidden | yes | backend/src/modules/workflows/workflows.routes.ts:299 |
| DELETE | /workflows/hidden/:workflowId | yes | backend/src/modules/workflows/workflows.routes.ts:311 |
| POST | /workflows/:workflowId/open-source | yes | backend/src/modules/workflows/workflows.routes.ts:321 |
| GET | /workflows/:workflowId/assets | yes | backend/src/modules/workflows/workflows.routes.ts:357 |
| POST | /workflows/:workflowId/assets/from-documents | yes | backend/src/modules/workflows/workflows.routes.ts:371 |
| DELETE | /workflows/:workflowId/assets/:assetId | yes | backend/src/modules/workflows/workflows.routes.ts:399 |
| GET | /workflows/:workflowId | yes | backend/src/modules/workflows/workflows.routes.ts:418 |
| GET | /workflows/:workflowId/people | yes | backend/src/modules/workflows/workflows.routes.ts:435 |
| GET | /workflows/:workflowId/shares | yes | backend/src/modules/workflows/workflows.routes.ts:452 |
| DELETE | /workflows/:workflowId/shares/:shareId | yes | backend/src/modules/workflows/workflows.routes.ts:469 |
| POST | /workflows/:workflowId/share | yes | backend/src/modules/workflows/workflows.routes.ts:492 |
