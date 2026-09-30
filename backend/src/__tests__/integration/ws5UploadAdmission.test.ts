import type { Server } from "node:http";
import http from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  authenticatedBodyLimit,
  authenticatedRateLimit,
  ipRateLimiter,
} from "../../lib/rateLimit";
import { requireAuthenticatedBody } from "../../middleware/authBody";

const configuration = vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.TRUST_PROXY_HOPS = "1";
  process.env.QUEUE_DRIVER = "postgres";
  delete process.env.REDIS_URL;
  process.env.RATE_LIMIT_UPLOAD_SESSION_MUTATION_MAX = "2";
  process.env.RATE_LIMIT_UPLOAD_SESSION_MUTATION_IP_MAX = "2";
  return { server: null as Server | null };
});

vi.mock("../../lib/supabase", () => ({
  createServerSupabase: () => ({
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
  }),
}));

const app = express();
const globalJsonParser = express.json({ limit: "1mb" });
app.set("trust proxy", 1);
app.use(ipRateLimiter("uploadMutation"));
app.use((req, res, next) => {
  if (authenticatedBodyLimit(req.method, req.path)) return next();
  globalJsonParser(req, res, next);
});
app.post(
  "/upload-sessions",
  requireAuthenticatedBody("256kb"),
  authenticatedRateLimit("uploadMutation"),
  (_req, res) => res.sendStatus(204),
);

beforeAll(async () => {
  configuration.server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => configuration.server?.once("listening", resolve));
});

afterAll(async () => {
  if (!configuration.server) return;
  await new Promise<void>((resolve) => configuration.server?.close(() => resolve()));
});

describe("WS5 upload body admission order", () => {
  it("rejects 2 MiB before parsing and rate-limits repeated attempts", async () => {
    const address = configuration.server?.address();
    if (!address || typeof address === "string") throw new Error("test server is not listening");
    const base = `http://127.0.0.1:${address.port}`;
    const contentLength = Buffer.byteLength(
      JSON.stringify({ note: "x".repeat(2 * 1024 * 1024) }),
    );
    const sendDeclaredLargeBody = () =>
      new Promise<{
        status: number;
        retryAfter: string | undefined;
        text: string;
      }>((resolve, reject) => {
        let settled = false;
        const req = http.request(
          `${base}/upload-sessions`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": String(contentLength),
              "X-Forwarded-For": "198.51.100.62",
              Connection: "close",
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => {
              settled = true;
              resolve({
                status: res.statusCode ?? 0,
                retryAfter: res.headers["retry-after"],
                text: Buffer.concat(chunks).toString("utf8"),
              });
            });
          },
        );
        req.setTimeout(5_000, () => req.destroy(new Error("rate-limit response timeout")));
        req.on("error", (error) => {
          if (!settled) reject(error);
        });
        // Send the large Content-Length but withhold its body. Admission/auth
        // must decide the request before a JSON parser waits for those bytes.
        req.flushHeaders();
      });

    const first = await sendDeclaredLargeBody();
    expect(first.status).toBe(403);
    expect(first.text).toContain("untrusted_origin");

    const second = await sendDeclaredLargeBody();
    expect(second.status).toBe(403);
    expect(second.text).toContain("untrusted_origin");

    const blocked = await sendDeclaredLargeBody();
    expect(blocked.status).toBe(429);
    expect(blocked.retryAfter).toBe("900");
    expect(blocked.text).not.toContain("198.51.100.62");
  }, 15000);
});
