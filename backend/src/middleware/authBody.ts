import express, { type RequestHandler } from "express";
import { requireAuth, requireAuthWithBody } from "./auth";

/**
 * Compose the authenticated body parser used by body-heavy routes. Route test
 * harnesses that replace only requireAuth retain the same auth-then-parse
 * order through the fallback; production uses requireAuthWithBody, which also
 * applies the default identity budget after parsing.
 */
export function requireAuthenticatedBody(
  limit: "256kb" | "2mb",
): RequestHandler {
  // Vitest route suites often replace the auth module with a small object that
  // exports only requireAuth. Vitest reports an undeclared mocked export when
  // the binding is read, so treat that case as the same auth-then-parse
  // fallback used by those suites.
  let authenticatedBodyMiddleware: typeof requireAuthWithBody | undefined;
  try {
    authenticatedBodyMiddleware = requireAuthWithBody;
  } catch {
    authenticatedBodyMiddleware = undefined;
  }
  if (typeof authenticatedBodyMiddleware === "function") {
    return authenticatedBodyMiddleware(limit);
  }

  const parser = express.json({ limit });
  return function requireAuthenticatedBody(req, res, next) {
    requireAuth(req, res, (authError) => {
      if (authError) {
        next(authError);
        return;
      }
      parser(req, res, next);
    });
  };
}
