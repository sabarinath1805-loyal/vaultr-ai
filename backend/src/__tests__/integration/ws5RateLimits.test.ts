import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const fakes = vi.hoisted(() => {
  const environmentNames = [
    "NODE_ENV",
    "QUEUE_DRIVER",
    "REDIS_URL",
    "RATE_LIMIT_GENERAL_MAX",
    "RATE_LIMIT_GENERAL_IP_MAX",
    "RATE_LIMIT_CHAT_MAX",
    "RATE_LIMIT_CHAT_IP_MAX",
    "RATE_LIMIT_EXPORT_MAX",
    "RATE_LIMIT_EXPORT_IP_MAX",
    "RATE_LIMIT_AUTH_LOGIN_MAX",
    "RATE_LIMIT_AUTH_ACCOUNT_MAX",
    "RATE_LIMIT_UPLOAD_SESSION_MUTATION_MAX",
    "RATE_LIMIT_UPLOAD_SESSION_MUTATION_IP_MAX",
    "RATE_LIMIT_UPLOAD_SESSION_CREATE_IP_MAX",
  ];
  const originalEnv = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));
  process.env.NODE_ENV = "test";
  process.env.QUEUE_DRIVER = "postgres";
  delete process.env.REDIS_URL;
  process.env.RATE_LIMIT_GENERAL_MAX = "10000";
  process.env.RATE_LIMIT_GENERAL_IP_MAX = "10000";
  process.env.RATE_LIMIT_CHAT_MAX = "30";
  process.env.RATE_LIMIT_CHAT_IP_MAX = "1500";
  process.env.RATE_LIMIT_EXPORT_MAX = "1";
  process.env.RATE_LIMIT_EXPORT_IP_MAX = "100";
  process.env.RATE_LIMIT_AUTH_LOGIN_MAX = "100";
  process.env.RATE_LIMIT_AUTH_ACCOUNT_MAX = "2";
  process.env.RATE_LIMIT_UPLOAD_SESSION_MUTATION_MAX = "2";
  process.env.RATE_LIMIT_UPLOAD_SESSION_MUTATION_IP_MAX = "200";
  process.env.RATE_LIMIT_UPLOAD_SESSION_CREATE_IP_MAX = "200";

  return {
    originalEnv,
    signInWithPassword: vi.fn(async (input: { email: string; password: string }) => {
      if (input.password !== "correct-horse") {
        return {
          data: { user: null, session: null },
          error: Object.assign(new Error("Invalid login credentials"), {
            status: 400,
          }),
        };
      }
      return {
        data: {
          user: { id: "login-user", email: input.email },
          session: { access_token: "synthetic-session", refresh_token: "synthetic-refresh" },
        },
        error: null,
      };
    }),
    signUp: vi.fn(async (input: { email: string }) => ({
      data: { user: { id: "signup-user", email: input.email }, session: null },
      error: null,
    })),
    resetPasswordForEmail: vi.fn(async (_email: string) => ({ data: {}, error: null })),
  };
});

function makeProfileQuery() {
  const query: Record<string, unknown> = {};
  for (const method of ["select", "eq", "update", "upsert", "insert", "delete"])
    query[method] = vi.fn(() => query);
  query.maybeSingle = vi.fn(async () => ({
    data: { mfa_on_login: false },
    error: null,
  }));
  query.single = query.maybeSingle;
  query.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve({ data: null, error: null }).then(resolve);
  return query;
}

vi.mock("../../lib/supabase", () => ({
  createServerSupabase: vi.fn(() => ({
    from: vi.fn(() => makeProfileQuery()),
    rpc: vi.fn(async () => ({ data: null, error: null })),
    auth: {
      getUser: vi.fn(async (token: string) => {
        if (!token.startsWith("ws5-user-")) {
          return { data: { user: null }, error: new Error("invalid token") };
        }
        const user = token.slice("ws5-user-".length);
        return {
          data: { user: { id: user, email: `${user}@example.test` } },
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
      signInWithPassword: (input: { email: string; password: string }) =>
        fakes.signInWithPassword(input),
      signUp: (input: { email: string }) => fakes.signUp(input),
      resetPasswordForEmail: (email: string) =>
        fakes.resetPasswordForEmail(email),
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

function bearer(userId: string) {
  return `Bearer ws5-user-${userId}`;
}

function fromIp(ip: string) {
  return { "X-Forwarded-For": ip };
}

async function chat(userId: string, ip: string) {
  return request(app)
    .post("/chat")
    .set("Authorization", bearer(userId))
    .set(fromIp(ip))
    .send({ messages: [] });
}

describe("WS5 rate-limit remediation regressions", () => {
  afterAll(() => {
    for (const [name, value] of Object.entries(fakes.originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  beforeEach(() => {
    fakes.signInWithPassword.mockClear();
  });

  it("keeps 99 peers usable after one user exhausts the chat budget", async () => {
    const officeIp = "198.51.100.41";
    let abuserResponse;
    for (let i = 0; i < 31; i++) {
      abuserResponse = await chat("ws5-abuser", officeIp);
    }
    expect(abuserResponse?.status).toBe(429);
    expect(abuserResponse?.headers["retry-after"]).toBeDefined();

    for (let i = 0; i < 99; i++) {
      const peer = await chat(`ws5-peer-${i}`, officeIp);
      expect(peer.status, `peer ${i} must not inherit the abuser's budget`).not.toBe(429);
    }

    // Other expensive families also receive their own identity-keyed budget.
    for (let i = 0; i < 99; i++) {
      const userId = `ws5-upload-peer-${i}`;
      const upload = await request(app)
        .post("/upload-sessions")
        .set("Authorization", bearer(userId))
        .set(fromIp(officeIp))
        .send({});
      expect(upload.status, `upload peer ${i}`).not.toBe(429);

      const exported = await request(app)
        .post("/users/exports")
        .set("Authorization", bearer(`ws5-export-peer-${i}`))
        .set(fromIp(officeIp))
        .send({ type: "not-an-export" });
      expect(exported.status, `export peer ${i}`).not.toBe(429);

      const tabular = await request(app)
        .post("/tabular-review")
        .set("Authorization", bearer(`ws5-tabular-peer-${i}`))
        .set(fromIp(officeIp))
        .send({});
      expect(tabular.status, `Tabular peer ${i}`).not.toBe(429);
    }
  }, 60000);

  it("keys failed login attempts by source and normalized identifier", async () => {
    const email = "  Victim@Example.Test ";
    for (const ip of ["198.51.100.51", "198.51.100.52"]) {
      const failed = await request(app)
        .post("/auth/login")
        .set("Origin", "http://localhost:3000")
        .set(fromIp(ip))
        .send({ email, password: "wrong-password" });
      expect(failed.status).not.toBe(429);
    }

    const cleanLogin = await request(app)
      .post("/auth/login")
      .set("Origin", "http://localhost:3000")
      .set(fromIp("198.51.100.53"))
      .send({ email: "victim@example.test", password: "correct-horse" });
    expect(cleanLogin.status).toBe(200);

    for (const ip of ["198.51.100.51", "198.51.100.52"]) {
      const secondFailure = await request(app)
        .post("/auth/login")
        .set("Origin", "http://localhost:3000")
        .set(fromIp(ip))
        .send({ email: "VICTIM@example.test", password: "wrong-password" });
      expect(secondFailure.status).not.toBe(429);

      const attackRepeat = await request(app)
        .post("/auth/login")
        .set("Origin", "http://localhost:3000")
        .set(fromIp(ip))
        .send({ email: "VICTIM@example.test", password: "wrong-password" });
      expect(attackRepeat.status).toBe(429);
      expect(
        JSON.stringify({ body: attackRepeat.body, headers: attackRepeat.headers }),
      ).not.toMatch(/victim@example\.test|198\.51\.100\.(51|52)|ws5-user/);
      expect(attackRepeat.headers["retry-after"]).toBeDefined();
    }
  });

  it("does not count successful login responses toward either failed-attempt budget", async () => {
    const headers = {
      Origin: "http://localhost:3000",
      ...fromIp("198.51.100.57"),
    };
    const failed = await request(app)
      .post("/auth/login")
      .set(headers)
      .send({ email: "skip-success@example.test", password: "wrong-password" });
    expect(failed.status).not.toBe(429);

    const successful = await request(app)
      .post("/auth/login")
      .set(headers)
      .send({ email: "skip-success@example.test", password: "correct-horse" });
    expect(successful.status).toBe(200);

    const secondFailure = await request(app)
      .post("/auth/login")
      .set(headers)
      .send({ email: "skip-success@example.test", password: "wrong-password" });
    expect(secondFailure.status).not.toBe(429);
    const thirdFailure = await request(app)
      .post("/auth/login")
      .set(headers)
      .send({ email: "skip-success@example.test", password: "wrong-password" });
    expect(thirdFailure.status).toBe(429);
    expect(
      JSON.stringify({ body: thirdFailure.body, headers: thirdFailure.headers }),
    ).not.toMatch(/skip-success@example\.test|198\.51\.100\.57|ws5-user/);
  });

  it("allows ordinary shared-office login failures, caps a coarse IP flood, and leaves another source usable", async () => {
    const officeIp = "198.51.100.55";
    for (let attempt = 0; attempt < 50; attempt++) {
      const response = await request(app)
        .post("/auth/login")
        .set("Origin", "http://localhost:3000")
        .set(fromIp(officeIp))
        .send({
          email: `office-${attempt}@example.test`,
          password: "wrong-password",
        });
      expect(response.status, `office failure ${attempt}`).not.toBe(429);
    }

    for (let attempt = 50; attempt < 100; attempt++) {
      const response = await request(app)
        .post("/auth/login")
        .set("Origin", "http://localhost:3000")
        .set(fromIp(officeIp))
        .send({
          email: `office-${attempt}@example.test`,
          password: "wrong-password",
        });
      expect(response.status, `coarse-IP failure ${attempt}`).not.toBe(429);
    }

    const flooded = await request(app)
      .post("/auth/login")
      .set("Origin", "http://localhost:3000")
      .set(fromIp(officeIp))
      .send({ email: "office-flood@example.test", password: "wrong-password" });
    expect(
      flooded.status,
      JSON.stringify({ headers: flooded.headers, body: flooded.body }),
    ).toBe(429);

    const independentSource = await request(app)
      .post("/auth/login")
      .set("Origin", "http://localhost:3000")
      .set(fromIp("198.51.100.56"))
      .send({ email: "valid@example.test", password: "correct-horse" });
    expect(independentSource.status).toBe(200);
  });

  it("keeps signup and password-reset identifier budgets separate", async () => {
    const identity = { email: "  person@example.test  ", password: "valid-password-123" };
    const headers = {
      Origin: "http://localhost:3000",
      ...fromIp("198.51.100.54"),
    };
    for (let attempt = 0; attempt < 10; attempt++) {
      const signup = await request(app)
        .post("/auth/signup")
        .set(headers)
        .send(identity);
      expect(signup.status, `signup ${attempt}`).toBe(201);
    }

    const blockedSignup = await request(app)
      .post("/auth/signup")
      .set(headers)
      .send(identity);
    expect(blockedSignup.status).toBe(429);

    const reset = await request(app)
      .post("/auth/password-reset")
      .set(headers)
      .send({ email: "person@example.test" });
    expect(reset.status).toBe(204);
    expect(reset.headers["retry-after"]).toBeUndefined();
  });

  it("rejects an unauthenticated malformed upload body before JSON parsing", async () => {
    const first = await request(app)
      .post("/upload-sessions")
      .set("Content-Type", "application/json")
      .set(fromIp("198.51.100.61"))
      .send('{"broken":');
    // Cookie-only mutations retain the existing 403 untrusted-origin result;
    // malformed JSON would have returned 400 if the parser ran first.
    expect(first.status).toBe(403);
  });

  it("shares the async-export budget across /user and /users aliases", async () => {
    const headers = {
      Authorization: bearer("ws5-export-alias-user"),
      ...fromIp("198.51.100.71"),
    };
    const first = await request(app)
      .post("/user/exports")
      .set(headers)
      .send({ type: "account" });
    expect(first.status).toBe(503); // local runner is intentionally disabled

    const second = await request(app)
      .post("/users/exports")
      .set(headers)
      .send({ type: "account" });
    expect(second.status).toBe(429);
    expect(second.headers["retry-after"]).toBeDefined();
    expect(JSON.stringify(second.body)).not.toMatch(/ws5-export-alias-user|198\.51\.100\.71/);
  });
});
