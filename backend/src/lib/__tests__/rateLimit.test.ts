import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import rateLimit, { type Options, type Store } from "express-rate-limit";
import {
  BoundedMemoryRateLimitStore,
  RateLimitStoreUnavailableError,
  RedisRateLimitStore,
  rateLimitStoreErrorHandler,
  rateLimitStoreErrorPolicy,
  ipRateLimiter,
  authenticatedRateLimit,
} from "../rateLimit";
import { routerErrorHandler } from "../../middleware/asyncRoute";

describe("bounded memory rate-limit store", () => {
  it("refuses unique-key growth at its cap and reclaims only expired entries", () => {
    let now = 1_000;
    const state = new Map<
      string,
      { totalHits: number; resetTime: Date }
    >();
    const store = new BoundedMemoryRateLimitStore({
      namespace: "bounded-test",
      maxKeys: 3,
      now: () => now,
      state,
    });
    store.init({ windowMs: 500 } as Options);

    expect(store.increment("a").totalHits).toBe(1);
    store.increment("b");
    store.increment("c");
    expect(store.keyCount()).toBe(3);
    expect(() => store.increment("d")).toThrow(RateLimitStoreUnavailableError);
    expect(store.keyCount()).toBe(3);

    now += 500;
    expect(store.increment("d").totalHits).toBe(1);
    expect(store.keyCount()).toBe(1);
  });
});

describe("shared Redis counter store", () => {
  it("shares one atomic key and fixed expiry across store instances", async () => {
    let now = 5_000;
    const data = new Map<string, { hits: number; expiresAt: number }>();
    const client = {
      eval: vi.fn(async (script: string, _keyCount: number, ...args: Array<string | number>) => {
        const key = String(args[0]);
        const current = data.get(key);
        if (script.includes("redis.call('INCR'")) {
          const ttl = Number(args[1]);
          const active = current && current.expiresAt > now ? current : undefined;
          const entry = active ?? { hits: 0, expiresAt: now + ttl };
          entry.hits += 1;
          data.set(key, entry);
          return [entry.hits, entry.expiresAt - now];
        }
        if (script.includes("redis.call('GET'")) {
          if (!current || current.expiresAt <= now) return [0, -2];
          return [current.hits, current.expiresAt - now];
        }
        if (script.includes("redis.call('DECR'")) {
          if (!current) return 0;
          current.hits -= 1;
          if (current.hits <= 0) data.delete(key);
          return current.hits;
        }
        if (script.includes("redis.call('DEL'")) {
          return Number(data.delete(key));
        }
        throw new Error("Unexpected fake Redis script");
      }),
    };
    const firstProcessStore = new RedisRateLimitStore(client, "shared-test", () => now);
    const secondProcessStore = new RedisRateLimitStore(client, "shared-test", () => now);
    firstProcessStore.init({ windowMs: 1_000 } as Options);
    secondProcessStore.init({ windowMs: 1_000 } as Options);

    expect((await firstProcessStore.increment("hashed-user-key")).totalHits).toBe(1);
    expect((await secondProcessStore.increment("hashed-user-key")).totalHits).toBe(2);
    expect(await secondProcessStore.get("hashed-user-key")).toMatchObject({
      totalHits: 2,
      resetTime: new Date(6_000),
    });
    expect(data.size).toBe(1);

    now += 1_000;
    expect((await secondProcessStore.increment("hashed-user-key")).totalHits).toBe(1);
  });
});

describe("limiter configuration isolation", () => {
  it("does not reuse a class limiter created with another configured cap", async () => {
    const original = process.env.RATE_LIMIT_CHAT_IP_MAX;
    process.env.RATE_LIMIT_CHAT_IP_MAX = "1";
    const strictLimiter = ipRateLimiter("chat");
    process.env.RATE_LIMIT_CHAT_IP_MAX = "2";
    const relaxedLimiter = ipRateLimiter("chat");

    const makeApp = (limiter: ReturnType<typeof ipRateLimiter>) => {
      const app = express();
      app.set("trust proxy", 1);
      app.get("/limited", limiter, (_req, res) => res.sendStatus(204));
      return app;
    };
    const strict = makeApp(strictLimiter);
    const relaxed = makeApp(relaxedLimiter);
    const strictHeaders = { "X-Forwarded-For": "198.51.100.81" };
    const relaxedHeaders = { "X-Forwarded-For": "198.51.100.82" };

    try {
      expect((await request(strict).get("/limited").set(strictHeaders)).status).toBe(204);
      expect((await request(strict).get("/limited").set(strictHeaders)).status).toBe(429);
      expect((await request(relaxed).get("/limited").set(relaxedHeaders)).status).toBe(204);
      expect((await request(relaxed).get("/limited").set(relaxedHeaders)).status).toBe(204);
      expect((await request(relaxed).get("/limited").set(relaxedHeaders)).status).toBe(429);
    } finally {
      if (original === undefined) delete process.env.RATE_LIMIT_CHAT_IP_MAX;
      else process.env.RATE_LIMIT_CHAT_IP_MAX = original;
    }
  });

  it("allows valid per-user requests, throttles only the over-limit user, and returns retry metadata", async () => {
    const oldMax = process.env.RATE_LIMIT_CHAT_MAX;
    process.env.RATE_LIMIT_CHAT_MAX = "2";
    const limiter = authenticatedRateLimit("chat");
    const app = express();
    app.post(
      "/limited",
      (req, res, next) => {
        res.locals.userId = req.get("x-test-user");
        next();
      },
      limiter,
      (_req, res) => res.sendStatus(204),
    );

    try {
      const userHeaders = { "X-Test-User": "ws5-unit-abuser" };
      expect((await request(app).post("/limited").set(userHeaders)).status).toBe(204);
      expect((await request(app).post("/limited").set(userHeaders)).status).toBe(204);
      const blocked = await request(app).post("/limited").set(userHeaders);
      expect(blocked.status).toBe(429);
      expect(blocked.headers["retry-after"]).toBeDefined();
      expect(JSON.stringify(blocked.body)).not.toContain("ws5-unit-abuser");

      const peer = await request(app)
        .post("/limited")
        .set({ "X-Test-User": "ws5-unit-peer" });
      expect(peer.status).toBe(204);
    } finally {
      if (oldMax === undefined) delete process.env.RATE_LIMIT_CHAT_MAX;
      else process.env.RATE_LIMIT_CHAT_MAX = oldMax;
    }
  });
});

describe("rate-limit store error policy", () => {
  function unavailableStore(): Store {
    return {
      localKeys: false,
      increment: () => {
        throw new RateLimitStoreUnavailableError("policy-test");
      },
      decrement: () => undefined,
      resetKey: () => undefined,
    };
  }

  function requestApp(passOnStoreError: boolean, routerScoped = false) {
    const app = express();
    const router = express.Router();
    const limiter = rateLimit({
      windowMs: 60_000,
      limit: 1,
      keyGenerator: () => "synthetic-key",
      store: unavailableStore(),
      passOnStoreError,
      logger: { error: vi.fn(), warn: vi.fn() },
    });
    const target = routerScoped ? router : app;
    target.get("/protected", limiter, (_req, res) => res.sendStatus(204));
    if (routerScoped) {
      router.use(routerErrorHandler("[rate-limit-test]"));
      app.use(router);
    }
    app.use(rateLimitStoreErrorHandler);
    return app;
  }

  it("returns a sanitized retryable 503 when a protected store fails", async () => {
    const response = await request(requestApp(false)).get("/protected");
    expect(response.status).toBe(503);
    expect(response.headers["retry-after"]).toBe("30");
    expect(response.body).toMatchObject({
      code: "rate_limit_unavailable",
      detail: "Request admission is temporarily unavailable. Please retry shortly.",
    });
    expect(JSON.stringify(response.body)).not.toMatch(/synthetic-key|policy-test/);

    const routerResponse = await request(requestApp(false, true)).get("/protected");
    expect(routerResponse.status).toBe(503);
    expect(routerResponse.headers["retry-after"]).toBe("30");
  });

  it("allows only configured low-risk IP backstops to fail open", async () => {
    const response = await request(requestApp(true)).get("/protected");
    expect(response.status).toBe(204);
    expect(rateLimitStoreErrorPolicy("general", "ip")).toBe("open");
    for (const [name, scope] of [
      ["general", "user"],
      ["chat", "user"],
      ["uploadMutation", "user"],
      ["export", "user"],
      ["authLoginIdentifierIp", "identifier-ip"],
    ] as const) {
      expect(rateLimitStoreErrorPolicy(name, scope)).toBe("closed");
    }
  });
});
