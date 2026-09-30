import "dotenv/config";
import { randomUUID } from "node:crypto";
import express, { type Router } from "express";
import cors from "cors";
import helmet from "helmet";
import { chatRouter } from "./modules/chat/chat.routes";
import { wordChatRouter } from "./modules/word-chat/wordChat.routes";
import { projectsRouter } from "./modules/projects/projects.routes";
import { orgsRouter } from "./modules/orgs/orgs.routes";
import { projectChatRouter } from "./modules/project-chat/projectChat.routes";
import { documentsRouter } from "./modules/documents/documents.routes";
import { libraryRouter } from "./modules/library/library.routes";
import { tabularRouter } from "./modules/tabular/tabular.routes";
import { workflowsRouter } from "./modules/workflows/workflows.routes";
import { quickActionsRouter } from "./modules/quick-actions/quickActions.routes";
import { workflowAddonsRouter } from "./modules/workflows/workflowAddons.routes";
import { userRouter } from "./modules/user/user.routes";
import { modelsRouter } from "./modules/models/models.routes";
import { downloadsRouter } from "./modules/downloads/downloads.routes";
import { sourceDocumentsRouter } from "./modules/source-documents/sourceDocuments.routes";
import { auditRouter } from "./modules/audit/audit.routes";
import { authRouter } from "./modules/auth/auth.routes";
import { uploadSessionsRouter } from "./modules/uploads/uploads.routes";
import {
  projectMemoryRouter,
  userMemoryRouter,
} from "./modules/memory/memory.routes";
import { manifestPublicKey } from "./lib/manifestSigning";
import {
  handleUnhandledError,
  protectInternalErrorResponses,
} from "./middleware/internalErrorResponse";
import { configuredAllowedOrigins } from "./lib/origins";
import { envInt } from "./lib/runtimeConfig";
import { tagCurrentRequest } from "./lib/observability/sentry";
import {
  authenticatedBodyLimit,
  identifierIpRateLimiter,
  ipRateLimiter,
  rateLimitStoreErrorHandler,
} from "./lib/rateLimit";

export const app = express();
const isProduction = process.env.NODE_ENV === "production";

// The Word tool-result return channel gets a generous IP backstop. Its
// identity-keyed budget is enforced after authentication in the router.
const TOOL_RESULT_PATH = "/word-chat/tool-result";
const generalLimiter = ipRateLimiter("general");
const toolResultLimiter = ipRateLimiter("toolResult");
const chatLimiter = ipRateLimiter("chat");
const chatCreateLimiter = ipRateLimiter("chatCreate");
const exportLimiter = ipRateLimiter("export");
const workflowImportLimiter = ipRateLimiter("workflowImport");
const dataDeleteLimiter = ipRateLimiter("dataDelete");
const authLoginIpLimiter = ipRateLimiter("authLoginIp");
const authLoginIdentifierIpLimiter = identifierIpRateLimiter("authLoginIdentifierIp");
const authEmailIpLimiter = ipRateLimiter("authEmailIp");
const authSignupIdentifierIpLimiter = identifierIpRateLimiter("authSignupIdentifierIp");
const authResetIdentifierIpLimiter = identifierIpRateLimiter("authResetIdentifierIp");
const authFlowLimiter = ipRateLimiter("authFlow");
const authMfaLimiter = ipRateLimiter("authMfa");
const uploadSessionIpLimiter = ipRateLimiter("uploadMutation");
const uploadSessionCreateIpLimiter = ipRateLimiter("uploadCreate");

const JSON_BODY_LIMIT = "1mb";
const globalJsonParser = express.json({ limit: JSON_BODY_LIMIT });
const generalLimiterMiddleware: express.RequestHandler = (req, res, next) => {
  if (
    req.path === TOOL_RESULT_PATH ||
    req.path === "/upload-sessions" ||
    req.path.startsWith("/upload-sessions/")
  ) {
    return next();
  }
  generalLimiter(req, res, next);
};
const deferBodyParsingForAuthenticatedRoutes: express.RequestHandler = (
  req,
  res,
  next,
) => {
  if (authenticatedBodyLimit(req.method, req.path)) return next();
  globalJsonParser(req, res, next);
};

app.disable("x-powered-by");
app.set("trust proxy", envInt("TRUST_PROXY_HOPS", 1));
app.use((_req, res, next) => {
  const requestId = randomUUID();
  res.locals.requestId = requestId;
  res.setHeader("X-Request-ID", requestId);
  // Same id on the Sentry event, the response body, and the access log.
  tagCurrentRequest(requestId);
  next();
});
app.use(protectInternalErrorResponses);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: isProduction
      ? {
          maxAge: 15552000,
          includeSubDomains: true,
        }
      : false,
    referrerPolicy: { policy: "no-referrer" },
  }),
);

export { configuredAllowedOrigins } from "./lib/origins";

const allowedOrigins = configuredAllowedOrigins();

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow server-to-server requests (no Origin header) and any
      // explicitly listed origin. A disallowed origin resolves to `false`
      // (cors omits the Access-Control-Allow-Origin header and the browser
      // blocks the response) rather than calling back with an Error —
      // throwing here would propagate to Express's default handler and turn
      // every disallowed cross-origin request, including preflight, into an
      // HTTP 500.
      callback(null, !origin || allowedOrigins.has(origin));
    },
    credentials: true,
    allowedHeaders: ["Authorization", "Content-Type"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    // The request id is the correlation key between a user report, the
    // access log, and the Sentry event. Browsers hide response headers from
    // cross-origin scripts unless they are listed here, so a dev build or a
    // self-hoster serving the API from another origin could not read it.
    exposedHeaders: ["X-Request-ID"],
  }),
);

app.use(generalLimiterMiddleware);

// Every upload control call gets cheap IP admission before auth/body parsing.
// Session creation also has a separate hourly coarse IP ceiling; the durable
// per-user session count remains enforced by the upload-session RPC.
app.use("/upload-sessions", uploadSessionIpLimiter);
app.post("/upload-sessions", uploadSessionCreateIpLimiter);

app.post("/auth/login", authLoginIpLimiter);
app.post(["/auth/signup", "/auth/password-reset"], authEmailIpLimiter);
app.post(["/auth/oauth", "/auth/exchange", "/auth/handoff"], authFlowLimiter);
app.post(
  [
    "/auth/mfa/enroll",
    "/auth/mfa/challenge",
    "/auth/mfa/verify",
    "/auth/mfa/challenge-and-verify",
  ],
  authMfaLimiter,
);

app.post("/chat", chatLimiter);
app.post("/word-chat", chatLimiter);
app.post(TOOL_RESULT_PATH, toolResultLimiter);
app.post("/projects/:projectId/chat", chatLimiter);
app.post("/tabular-review/:reviewId/chat", chatLimiter);
app.post("/tabular-review/:reviewId/generate", chatLimiter);
app.post("/tabular-review/prompt", chatLimiter);
app.post("/tabular-review/:reviewId/regenerate-cell", chatLimiter);
app.post("/chat/create", chatCreateLimiter);
app.post("/chat/:chatId/generate-title", chatCreateLimiter);
app.post("/workflow-addons/:addonId/import", workflowImportLimiter);
const legacyUploadRemoved = (_req: express.Request, res: express.Response) => {
  res.status(410).json({
    code: "upload_session_required",
    detail: "This upload endpoint has been replaced by /upload-sessions.",
  });
};

// Reject the former multipart endpoints before any body parser or route-level
// body-reading middleware can consume file bytes. Browser clients use the
// direct object-storage upload-session protocol instead.
app.post("/single-documents", legacyUploadRemoved);
app.post("/library/:kind/documents", legacyUploadRemoved);
app.post("/single-documents/:documentId/versions", legacyUploadRemoved);
app.put(
  "/single-documents/:documentId/versions/:versionId/file",
  legacyUploadRemoved,
);
app.post("/projects/:projectId/documents", legacyUploadRemoved);
app.get("/projects/:projectId/export", exportLimiter);
app.get("/user/export", exportLimiter);
app.get("/user/chats/export", exportLimiter);
app.get("/user/tabular-reviews/export", exportLimiter);
app.get("/users/export", exportLimiter);
app.get("/users/chats/export", exportLimiter);
app.get("/users/tabular-reviews/export", exportLimiter);
app.get("/audit/export", exportLimiter);
// Scheduling an async export has the same identity-keyed budget under either
// router alias. Polling and download routes remain on the general user cap.
app.post(["/user/exports", "/users/exports"], exportLimiter);
app.delete(
  [
    "/user/account",
    "/user/chats",
    "/user/projects",
    "/user/tabular-reviews",
    "/user/memories",
    "/users/account",
    "/users/chats",
    "/users/projects",
    "/users/tabular-reviews",
    "/users/memories",
  ],
  dataDeleteLimiter,
);

// Login uses two independent failure counters: one coarse source-IP counter,
// and one normalized identifier + source-IP digest. Signup and reset use
// separate action buckets so one action cannot consume the other's budget.
app.use(deferBodyParsingForAuthenticatedRoutes);
app.post("/auth/login", authLoginIdentifierIpLimiter);
app.post("/auth/signup", authSignupIdentifierIpLimiter);
app.post("/auth/password-reset", authResetIdentifierIpLimiter);

export const routeMounts: Array<{ path: string | string[]; router: Router }> = [
  { path: "/auth", router: authRouter },
  { path: "/chat", router: chatRouter },
  { path: "/word-chat", router: wordChatRouter },
  { path: "/models", router: modelsRouter },
  { path: "/projects/:projectId/memory", router: projectMemoryRouter },
  { path: "/projects", router: projectsRouter },
  { path: "/orgs", router: orgsRouter },
  { path: "/projects/:projectId/chat", router: projectChatRouter },
  { path: "/single-documents", router: documentsRouter },
  { path: "/library", router: libraryRouter },
  { path: "/tabular-review", router: tabularRouter },
  { path: "/workflows", router: workflowsRouter },
  { path: "/quick-actions", router: quickActionsRouter },
  { path: "/workflow-addons", router: workflowAddonsRouter },
  { path: "/user/memory", router: userMemoryRouter },
  { path: ["/user", "/users"], router: userRouter },
  { path: "/download", router: downloadsRouter },
  { path: "/documents", router: sourceDocumentsRouter },
  { path: "/audit", router: auditRouter },
  { path: "/upload-sessions", router: uploadSessionsRouter },
];
for (const mount of routeMounts) app.use(mount.path, mount.router);

app.get("/health", (_req, res) => res.json({ ok: true }));

// Deliberate failure for verifying the error pipeline end to end (a real
// thrown error through the real 500 path, so the Sentry event carries the
// request id the caller sees). Opt-in per deployment: it is an unauthenticated
// way to generate events, so leave it off once the DSN is confirmed working.
if (process.env.SENTRY_ENABLE_TEST_ROUTE === "true") {
  app.get("/observability/sentry-test", () => {
    throw Object.assign(new Error("Sentry backend test error (SENTRY_ENABLE_TEST_ROUTE)"), { code: "sentry_test" });
  });
}

// The Ed25519 public key this deployment signs project export manifests with,
// or null when no key is configured. Deliberately open: whoever checks a
// manifest is usually outside the workspace, and they need to get the key from
// the server rather than trust the copy inside the file they were handed.
app.get("/manifest-signing-key", (_req, res) => {
  try {
    res.json(manifestPublicKey());
  } catch (err) {
    console.error("[manifest-signing-key] failed", err);
    res.status(500).json({
      detail: "Manifest signing key is misconfigured",
    });
  }
});

// Terminal error handler. Routers mount routerErrorHandler("[tag]") so a
// failure is attributed to its router in the log; the response is delegated
// back here, so every router answers with the same body. Anything that escapes
// a router lands here too, instead of Express's default handler, which would
// leak the stack trace in a non-production environment. Must stay last: Express
// only reaches an error handler registered after the middleware that failed.
app.use(rateLimitStoreErrorHandler);
app.use(handleUnhandledError);
