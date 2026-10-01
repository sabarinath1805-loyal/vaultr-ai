import express from "express";
import { afterAll, describe, expect, it, beforeAll } from "vitest";
import { createSupertestClient } from "../helpers/supertestClient";
import { authenticatedRateLimit, ipRateLimiter } from "../../lib/rateLimit";



const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  QUEUE_DRIVER: process.env.QUEUE_DRIVER,
  REDIS_URL: process.env.REDIS_URL,
  RATE_LIMIT_CHAT_MAX: process.env.RATE_LIMIT_CHAT_MAX,
  RATE_LIMIT_CHAT_IP_MAX: process.env.RATE_LIMIT_CHAT_IP_MAX,
};
process.env.NODE_ENV = "test";
process.env.QUEUE_DRIVER = "postgres";
delete process.env.REDIS_URL;
process.env.RATE_LIMIT_CHAT_MAX = "2";
delete process.env.RATE_LIMIT_CHAT_IP_MAX;

const app = express();
const sharedHttpClient = createSupertestClient(app);
beforeAll(sharedHttpClient.start);
afterAll(sharedHttpClient.close);

app.set("trust proxy", 1);
app.post(
  "/chat",
  (req, res, next) => {
    res.locals.userId = req.get("x-test-user");
    next();
  },
  ipRateLimiter("chat"),
  authenticatedRateLimit("chat"),
  (_req, res) => res.sendStatus(204),
);

describe("WS5b shared-office chat defaults", () => {
  afterAll(() => {
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("derives a 50x shared-IP backstop and admits 100 users with one request each", async () => {
    const officeIp = "198.51.100.201";
    // A reduced per-user fixture keeps this deterministic: 50x two is 100,
    // enough for one request from each of 100 distinct users. At the real
    // chat defaults, the equivalent ceiling is 30 * 50 = 1,500/IP/window.
    for (let user = 0; user < 100; user++) {
      const response = await sharedHttpClient.request()
        .post("/chat")
        .set("X-Test-User", `office-user-${user}`)
        .set("X-Forwarded-For", officeIp);
      expect(
        response.status,
        `user ${user}: ${JSON.stringify({
          status: response.status,
          body: response.text,
          headers: response.headers,
        })}`,
      ).toBe(204);
    }

    const overBudget = await sharedHttpClient.request()
      .post("/chat")
      .set("X-Test-User", "office-user-after-budget")
      .set("X-Forwarded-For", officeIp);
    expect(overBudget.status).toBe(429);
    expect(overBudget.headers["retry-after"]).toBeDefined();
  }, 90_000);
});
