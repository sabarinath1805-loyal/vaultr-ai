import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it, vi } from "vitest";
import {
  evaluateProductionConfiguration,
  validateProductionConfiguration,
} from "../productionConfig";

const validProduction = {
  NODE_ENV: "production",
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "publishable-key-that-is-not-a-demo-value",
  SUPABASE_SECRET_KEY: "service-role-key-that-is-not-a-demo-value",
  JWT_SECRET: "j".repeat(48),
  USER_API_KEYS_ENCRYPTION_SECRET: "u".repeat(48),
  MCP_CONNECTORS_ENCRYPTION_SECRET: "m".repeat(48),
  AUTH_HANDOFF_ENCRYPTION_SECRET: "h".repeat(48),
  TRUST_PROXY_HOPS: "1",
  FRONTEND_URL: "https://app.example.test",
  API_PUBLIC_URL: "https://app.example.test/api",
  ALLOWED_ORIGINS: "https://app.example.test",
  R2_ENDPOINT_URL: "https://account.r2.example.test",
  R2_BUCKET_NAME: "vaultr-prod",
  R2_ACCESS_KEY_ID: "r2-access-key-id-not-a-demo",
  R2_SECRET_ACCESS_KEY: "r2-secret-access-key-not-a-demo",
  REDIS_URL: "rediss://:redis-password@redis.internal:6379",
  API_REPLICAS: "2",
  SENTRY_DSN: "https://public@o1.ingest.sentry.io/1",
} as NodeJS.ProcessEnv;

function sensitiveValuesFromRepository(): string[] {
  const files = [
    resolve(process.cwd(), "../.env.example"),
    resolve(process.cwd(), ".env.example"),
    resolve(process.cwd(), "../frontend/.env.local.example"),
    resolve(process.cwd(), "../word-addin/.env.example"),
    resolve(process.cwd(), "../docker-compose.yml"),
  ];
  const sensitiveName =
    /(?:SECRET|PASSWORD|TOKEN|JWT_SECRET|(?:API|ANON|PUBLISHABLE|SERVICE_ROLE|PRIVATE|ACCESS|SECRET)_KEY(?:_ID)?|_KEY)$/i;
  const values: string[] = [];

  for (const file of files) {
    const contents = readFileSync(file, "utf8");
    if (file.endsWith(".yml")) {
      const document = parseYaml(contents) as {
        services?: Record<
          string,
          { environment?: Record<string, unknown> | string[] }
        >;
      };
      for (const service of Object.values(document.services ?? {})) {
        const environment = service.environment ?? {};
        if (Array.isArray(environment)) {
          for (const assignment of environment) {
            const equals = assignment.indexOf("=");
            if (equals > 0 && sensitiveName.test(assignment.slice(0, equals))) {
              values.push(assignment.slice(equals + 1));
            }
          }
        } else {
          for (const [name, value] of Object.entries(environment)) {
            if (sensitiveName.test(name) && typeof value === "string") {
              values.push(value);
            }
          }
        }
      }
      continue;
    }

    for (const line of contents.split(/\r?\n/)) {
      const assignment = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!assignment || !sensitiveName.test(assignment[1])) continue;
      values.push(assignment[2].replace(/\s+#.*$/, ""));
    }
  }

  return values
    .map((value) => {
      const composeDefault = value.match(/^\$\{[^:}]+:-([\s\S]*)\}$/);
      const unquoted = (composeDefault?.[1] ?? value)
        .replace(/^(['"])(.*)\1$/, "$2")
        .trim();
      if (!unquoted || unquoted.startsWith("<")) return "";
      return unquoted;
    })
    .filter(Boolean);
}

describe("production configuration guard", () => {
  it("accepts a complete production configuration", () => {
    expect(evaluateProductionConfiguration(validProduction)).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it.each(["development", "test", undefined])(
    "does nothing outside production mode (%s)",
    (nodeEnv) => {
      const env = { NODE_ENV: nodeEnv } as NodeJS.ProcessEnv;
      expect(evaluateProductionConfiguration(env)).toEqual({
        errors: [],
        warnings: [],
      });
      expect(() => validateProductionConfiguration(env)).not.toThrow();
    },
  );

  it.each([
    ["SUPABASE_SECRET_KEY", undefined, "required"],
    ["SUPABASE_SECRET_KEY", "service-role-key-that-is-not-a-demo-value", "must differ"],
    ["SUPABASE_PUBLISHABLE_KEY", undefined, "required"],
    ["JWT_SECRET", "short", "at least 32 characters"],
    ["USER_API_KEYS_ENCRYPTION_SECRET", "short", "at least 32 characters"],
    ["TRUST_PROXY_HOPS", undefined, "must be explicitly set"],
    ["TRUST_PROXY_HOPS", "one", "non-negative integer"],
    ["ALLOWED_ORIGINS", "*", "exact origins"],
    ["ALLOWED_ORIGINS", "https://*.example.test", "wildcards are not allowed"],
    ["ALLOWED_ORIGINS", "http://app.example.test", "must use https"],
    ["FRONTEND_URL", "http://app.example.test", "must use https"],
    ["R2_ENDPOINT_URL", "http://storage.example.test", "must use https"],
    ["SUPABASE_URL", "http://localhost:54321", "must not point to localhost or loopback"],
    ["RATE_LIMIT_CHAT_MAX", "0", "positive finite integer"],
    ["RATE_LIMIT_EXPORT_MAX", "unlimited", "positive finite integer"],
    ["DEBUG_LLM_TOOL_CALLS", "1", "must be disabled"],
    ["LOG_RAW_LLM_STREAM", "true", "must be disabled"],
    ["SENTRY_ENABLE_TEST_ROUTE", "true", "must be disabled"],
    ["MODEL_PRIVATE_ENDPOINT_ALLOWLIST", "http://169.254.169.254", "link-local"],
  ] as const)("rejects unsafe %s (%s)", (name, value, issue) => {
    const env = {
      ...validProduction,
      [name]: value,
      ...(name === "SUPABASE_SECRET_KEY"
        ? { SUPABASE_PUBLISHABLE_KEY: "service-role-key-that-is-not-a-demo-value" }
        : {}),
    } as NodeJS.ProcessEnv;
    expect(evaluateProductionConfiguration(env).errors.join("\n")).toContain(issue);
  });

  it("allows explicitly configured zero proxy hops for a direct, no-proxy deployment", () => {
    expect(
      evaluateProductionConfiguration({
        ...validProduction,
        TRUST_PROXY_HOPS: "0",
      }).errors,
    ).toEqual([]);
  });

  it("never includes configured secret values in fail-fast errors", () => {
    const sentinel = "synthetic-secret-value-must-not-be-logged";
    try {
      validateProductionConfiguration({
        ...validProduction,
        SUPABASE_SECRET_KEY: sentinel,
        SUPABASE_PUBLISHABLE_KEY: sentinel,
      });
      throw new Error("expected production validation to fail");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("SUPABASE_SECRET_KEY");
      expect(message).not.toContain(sentinel);
    }
  });

  it("rejects known checked-in secret defaults by fingerprint without echoing values", () => {
    const values = sensitiveValuesFromRepository();
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      const env = {
        ...validProduction,
        SUPABASE_SECRET_KEY: value,
      } as NodeJS.ProcessEnv;
      const message = evaluateProductionConfiguration(env).errors.join("\n");
      expect(message).toContain(
        "checked-in demo/default value",
      );
      expect(message).not.toContain(value);
    }
  });

  it("emits one coalesced warning without values when optional settings are absent", () => {
    const warn = vi.fn();
    const env = {
      ...validProduction,
      REDIS_URL: undefined,
      SENTRY_DSN: undefined,
      MCP_CONNECTORS_ENCRYPTION_SECRET: undefined,
      API_REPLICAS: "3",
    } as NodeJS.ProcessEnv;
    expect(() => validateProductionConfiguration(env, warn)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("REDIS_URL");
    expect(String(warn.mock.calls[0]?.[0])).toContain("SENTRY_DSN");
    expect(String(warn.mock.calls[0]?.[0])).toContain("API_REPLICAS");
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("redis-password");
  });

  it("warns for non-loopback Redis without auth or TLS", () => {
    const warnings = evaluateProductionConfiguration({
      ...validProduction,
      REDIS_URL: "redis://redis.internal:6379",
      API_REPLICAS: "2",
    }).warnings.join("\n");
    expect(warnings).toContain("REDIS_URL");
  });
});
