import { afterAll, describe, expect, it, vi, beforeAll } from "vitest";
import { createSupertestClient } from "../helpers/supertestClient";

const fakes = vi.hoisted(() => {
  const environmentNames = [
    "NODE_ENV",
    "QUEUE_DRIVER",
    "REDIS_URL",
    "RATE_LIMIT_REDIS_TIMEOUT_MS",
    "RATE_LIMIT_REDIS_FAILURE_THRESHOLD",
    "RATE_LIMIT_REDIS_COOLDOWN_MS",
    "RATE_LIMIT_GENERAL_MAX",
    "RATE_LIMIT_GENERAL_IP_MAX",
    "RATE_LIMIT_CHAT_MAX",
    "RATE_LIMIT_CHAT_IP_MAX",
    "RATE_LIMIT_EXPORT_MAX",
    "RATE_LIMIT_EXPORT_IP_MAX",
    "RATE_LIMIT_AUTH_LOGIN_MAX",
    "RATE_LIMIT_AUTH_ACCOUNT_MAX",
    "RATE_LIMIT_AUTH_EMAIL_IP_MAX",
    "RATE_LIMIT_UPLOAD_SESSION_MUTATION_MAX",
    "RATE_LIMIT_UPLOAD_SESSION_MUTATION_IP_MAX",
    "RATE_LIMIT_UPLOAD_SESSION_CREATE_IP_MAX",
  ];
  const originalEnv = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));
  process.env.NODE_ENV = "test";
  process.env.QUEUE_DRIVER = "postgres";
  process.env.REDIS_URL = "redis://127.0.0.1:1";
  process.env.RATE_LIMIT_REDIS_TIMEOUT_MS = "50";
  process.env.RATE_LIMIT_REDIS_FAILURE_THRESHOLD = "1";
  process.env.RATE_LIMIT_REDIS_COOLDOWN_MS = "60000";
  process.env.RATE_LIMIT_GENERAL_MAX = "10000";
  process.env.RATE_LIMIT_GENERAL_IP_MAX = "10000";
  process.env.RATE_LIMIT_CHAT_MAX = "2";
  process.env.RATE_LIMIT_CHAT_IP_MAX = "3";
  process.env.RATE_LIMIT_EXPORT_MAX = "1";
  process.env.RATE_LIMIT_EXPORT_IP_MAX = "3";
  process.env.RATE_LIMIT_AUTH_LOGIN_MAX = "3";
  process.env.RATE_LIMIT_AUTH_ACCOUNT_MAX = "10";
  process.env.RATE_LIMIT_AUTH_EMAIL_IP_MAX = "20";
  process.env.RATE_LIMIT_UPLOAD_SESSION_MUTATION_MAX = "2";
  process.env.RATE_LIMIT_UPLOAD_SESSION_MUTATION_IP_MAX = "3";
  process.env.RATE_LIMIT_UPLOAD_SESSION_CREATE_IP_MAX = "20";

  return {
    originalEnv,
    signInWithPassword: vi.fn(async (_input: { email: string; password: string }) => ({
      data: { user: null, session: null },
      error: Object.assign(new Error("Invalid login credentials"), {
        status: 400,
      }),
    })),
    signUp: vi.fn(async (input: { email: string }) => ({
      data: {
        user: { id: "ws5b-signup-user", email: input.email },
        session: null,
      },
      error: null,
    })),
    resetPasswordForEmail: vi.fn(async (_email: string) => ({ data: {}, error: null })),
  };
});

function makeProfileQuery() {
  const query: Record<string, unknown> = {};
  for (const method of ["select", "eq", "update", "upsert", "insert", "delete"]) query[method] = vi.fn(() => query);
  query.maybeSingle = vi.fn(async () => ({
    data: { mfa_on_login: false },
    error: null,
  }));
  query.single = query.maybeSingle;
  query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve);
  return query;
}

vi.mock("../../lib/supabase", () => ({
  createServerSupabase: vi.fn(() => ({
    from: vi.fn(() => makeProfileQuery()),
    rpc: vi.fn(async () => ({ data: null, error: null })),
    auth: {
      getUser: vi.fn(async (token: string) => {
        if (!token.startsWith("ws5b-user-")) {
          return { data: { user: null }, error: new Error("invalid token") };
        }
        const id = token.slice("ws5b-user-".length);
        return {
          data: { user: { id, email: `${id}@example.test` } },
          error: null,
        };
      }),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({
          data: { currentLevel: "aal1", nextLevel: "aal1" },
          error: null,
        })),
      },
    },
  })),
}));

vi.mock("../../lib/userLookup", () => ({
  syncProfileEmail: vi.fn(async () => null),
}));
vi.mock("../../lib/authSession", () => ({
  clearRequestAuthCookies: vi.fn(),
  createRequestSupabase: vi.fn(() => ({
    auth: {
      signInWithPassword: (input: { email: string; password: string }) => fakes.signInWithPassword(input),
      signUp: (input: { email: string }) => fakes.signUp(input),
      resetPasswordForEmail: (email: string) => fakes.resetPasswordForEmail(email),
    },
  })),
  publicAuthUser: vi.fn((user: unknown) => user),
}));
vi.mock("../../lib/dbq/runner", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, dbJobsEnabled: () => false };
});
vi.mock("../../lib/storage", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, storageEnabled: false };
});

import { app } from "../../app";
import { closeRedisConnection } from "../../lib/queue/connection";

const sharedHttpClient = createSupertestClient(app);
beforeAll(sharedHttpClient.start);
afterAll(sharedHttpClient.close);

const ip = (value: string) => ({ "X-Forwarded-For": value });
const bearer = (id: string) => `Bearer ws5b-user-${id}`;

describe("WS5b production Express rate-limit assembly", () => {
  afterAll(async () => {
    await closeRedisConnection();
    for (const [name, value] of Object.entries(fakes.originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("enforces app-registered coarse IP limits on chat, upload, export, Tabular, and login", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cases = [
      {
        name: "chat",
        path: "/chat",
        body: { messages: [] },
        address: "198.51.100.101",
      },
      {
        name: "upload",
        path: "/upload-sessions",
        body: {},
        address: "198.51.100.102",
      },
      {
        name: "export",
        path: "/users/exports",
        body: { type: "account" },
        address: "198.51.100.103",
      },
      {
        name: "Tabular",
        path: "/tabular-review/prompt",
        body: {},
        address: "198.51.100.104",
      },
    ];

    for (const testCase of cases) {
      for (let index = 0; index < 3; index++) {
        const response = await sharedHttpClient.request()
          .post(testCase.path)
          .set("Authorization", bearer(`${testCase.name}-${index}`))
          .set(ip(testCase.address))
          .send(testCase.body);
        expect(response.status, `${testCase.name} allowed request ${index}`).not.toBe(429);
        expect(response.body.code).not.toBe("rate_limit_unavailable");
      }
      const blocked = await sharedHttpClient.request()
        .post(testCase.path)
        .set("Authorization", bearer(`${testCase.name}-rotated-identity`))
        .set(ip(testCase.address))
        .send(testCase.body);
      expect(blocked.status, `${testCase.name} IP backstop`).toBe(429);
      expect(blocked.headers["retry-after"]).toBeDefined();
    }

    const loginIp = "198.51.100.105";
    for (let index = 0; index < 3; index++) {
      const response = await sharedHttpClient.request()
        .post("/auth/login")
        .set("Origin", "http://localhost:3000")
        .set(ip(loginIp))
        .send({ email: `person-${index}@example.test`, password: "incorrect" });
      expect(response.status, `login failure ${index}`).not.toBe(429);
      expect(response.body.code).not.toBe("rate_limit_unavailable");
    }
    const blockedLogin = await sharedHttpClient.request()
      .post("/auth/login")
      .set("Origin", "http://localhost:3000")
      .set(ip(loginIp))
      .send({ email: "fourth@example.test", password: "incorrect" });
    expect(blockedLogin.status).toBe(429);
    const degradedWarnings = warning.mock.calls.filter(
      ([message]) => message === "[rate-limit] store degraded",
    );
    expect(degradedWarnings).toHaveLength(1);
    expect(degradedWarnings[0]?.[1]).toMatchObject({
      limiter: "general:ip",
      reason: "Redis rate-limit operation failed",
      mode: "memory",
    });
    expect(JSON.stringify(degradedWarnings)).not.toMatch(/198\.51\.100\.|ws5b-user|example\.test/);
    warning.mockRestore();
  });

  it("keeps authenticated budgets keyed to users and shares export limits across aliases", async () => {
    const user = "single-export-user";
    const first = await sharedHttpClient.request()
      .post("/user/exports")
      .set("Authorization", bearer(user))
      .set(ip("198.51.100.111"))
      .send({ type: "account" });
    expect(first.status).not.toBe(429);

    const aliasReplay = await sharedHttpClient.request()
      .post("/users/exports")
      .set("Authorization", bearer(user))
      .set(ip("198.51.100.112"))
      .send({ type: "account" });
    expect(aliasReplay.status).toBe(429);
    expect(aliasReplay.headers["retry-after"]).toBeDefined();

    const peer = await sharedHttpClient.request()
      .post("/users/exports")
      .set("Authorization", bearer("different-export-user"))
      .set(ip("198.51.100.112"))
      .send({ type: "account" });
    expect(peer.status).not.toBe(429);
  });

  it("keeps auth flows, general reads, and individual chat/upload budgets available during Redis outage", async () => {
    const origin = "http://localhost:3000";
    const signUp = await sharedHttpClient.request().post("/auth/signup").set("Origin", origin).set(ip("198.51.100.131")).send({
      email: "new-person@example.test",
      password: "synthetic-password-123",
    });
    expect(signUp.status).toBe(201);
    expect(signUp.body.code).not.toBe("rate_limit_unavailable");

    const reset = await sharedHttpClient.request()
      .post("/auth/password-reset")
      .set("Origin", origin)
      .set(ip("198.51.100.132"))
      .send({ email: "existing-person@example.test" });
    expect(reset.status).toBe(204);

    const generalRead = await sharedHttpClient.request()
      .get("/user/api-keys")
      .set("Authorization", bearer("ws5b-general-reader"))
      .set(ip("198.51.100.133"));
    expect(generalRead.status).not.toBe(503);
    expect(generalRead.body.code).not.toBe("rate_limit_unavailable");

    const user = "ws5b-chat-abuser";
    for (let index = 0; index < 2; index++) {
      const response = await sharedHttpClient.request()
        .post("/chat")
        .set("Authorization", bearer(user))
        .set(ip(`198.51.100.${140 + index}`))
        .send({ messages: [] });
      expect(response.status).not.toBe(429);
      expect(response.body.code).not.toBe("rate_limit_unavailable");
    }
    const chatOverBudget = await sharedHttpClient.request()
      .post("/chat")
      .set("Authorization", bearer(user))
      .set(ip("198.51.100.142"))
      .send({ messages: [] });
    expect(chatOverBudget.status).toBe(429);

    const uploadUser = "ws5b-upload-abuser";
    for (let index = 0; index < 2; index++) {
      const response = await sharedHttpClient.request()
        .post("/upload-sessions")
        .set("Authorization", bearer(uploadUser))
        .set(ip(`198.51.100.${150 + index}`))
        .send({});
      expect(response.status).not.toBe(429);
      expect(response.body.code).not.toBe("rate_limit_unavailable");
    }
    const uploadOverBudget = await sharedHttpClient.request()
      .post("/upload-sessions")
      .set("Authorization", bearer(uploadUser))
      .set(ip("198.51.100.152"))
      .send({});
    expect(uploadOverBudget.status).toBe(429);
  });

  it("keeps the existing fixed proxy-hop setting in the production app", async () => {
    const response = await sharedHttpClient.request()
      .post("/chat")
      .set("Authorization", bearer("proxy-hop-user"))
      .set("X-Forwarded-For", "198.51.100.121, 203.0.113.9")
      .send({ messages: [] });
    // TRUST_PROXY_HOPS=1 is read during app assembly; the request reaches the
    // handler and does not cause Express's untrusted-proxy validation error.
    expect(response.status).not.toBe(500);
  });
});
