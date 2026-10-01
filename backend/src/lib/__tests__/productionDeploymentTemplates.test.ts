import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { evaluateProductionConfiguration } from "../productionConfig";

const composePath = resolve(process.cwd(), "../deploy/docker-compose.prod.yml");
const caddyPath = resolve(process.cwd(), "../deploy/Caddyfile");
const envPath = resolve(process.cwd(), "../deploy/.env.production.example");
const composeText = readFileSync(composePath, "utf8");
const caddyText = readFileSync(caddyPath, "utf8");
const envText = readFileSync(envPath, "utf8");
const compose = parseYaml(composeText) as {
  services: Record<
    string,
    {
      image?: string;
      user?: string;
      read_only?: boolean;
      cap_drop?: string[];
      cap_add?: string[];
      ports?: string[];
      environment?: Record<string, string>;
      env_file?: string[];
      command?: string[];
      networks?: string[];
      restart?: string;
      healthcheck?: unknown;
      deploy?: { resources?: { limits?: { cpus?: string; memory?: string } } };
      pids_limit?: number;
    }
  >;
  networks: Record<string, { internal?: boolean }>;
};

function exampleEnvironment(): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const line of envText.split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match) entries[match[1]] = match[2];
  }
  return entries;
}

function secretLike(name: string): boolean {
  return /(?:_SECRET(?:_|$)|_PASSWORD(?:_|$)|_TOKEN(?:_|$)|_API_KEY(?:_|$)|_ACCESS_KEY(?:_ID)?(?:_|$)|_PUBLISHABLE_KEY(?:_|$)|_ANON_KEY(?:_|$)|_SERVICE_ROLE_KEY(?:_|$)|_PRIVATE_KEY(?:_|$)|JWT_SECRET$)/i.test(
    name,
  );
}

describe("production deployment templates", () => {
  it("publishes only the proxy and keeps backend, worker, and Redis private", () => {
    const publishers = Object.entries(compose.services)
      .filter(([, service]) => (service.ports?.length ?? 0) > 0)
      .map(([name]) => name);
    expect(publishers).toEqual(["caddy"]);
    expect(compose.services.caddy.ports).toEqual(["80:80", "443:443"]);
    expect(compose.networks.app_internal.internal).toBe(true);
    expect(compose.networks.api_internal.internal).toBe(true);
    expect(compose.services.backend.networks).toContain("app_internal");
    expect(compose.services.backend.networks).toContain("api_internal");
    expect(compose.services.backend.networks).not.toContain("edge");
    expect(compose.services.worker.networks).toContain("app_internal");
    expect(compose.services.worker.networks).not.toContain("api_internal");
    expect(compose.services.worker.networks).not.toContain("edge");
    expect(compose.services.redis.networks).toEqual(["app_internal"]);
    expect(compose.services.caddy.networks).toEqual(["edge"]);
    expect(compose.services.frontend.networks).toContain("api_internal");
    expect(compose.services.frontend.networks).not.toContain("app_internal");
    expect(compose.services["word-addin"].networks).toContain("api_internal");
    expect(compose.services["word-addin"].networks).not.toContain("app_internal");
    expect(compose.services.backend.networks).toContain("provider_egress");
    expect(compose.services.worker.networks).toContain("provider_egress");
    expect(compose.services.frontend.networks).not.toContain("provider_egress");
  });

  it("runs every service as a non-root user with read-only rootfs and bounded resources", () => {
    for (const [name, service] of Object.entries(compose.services)) {
      expect(service.user, `${name} user`).toBeTruthy();
      expect(service.user?.toLowerCase()).not.toBe("root");
      expect(service.read_only, `${name} root filesystem`).toBe(true);
      expect(service.cap_drop, `${name} capabilities`).toContain("ALL");
      expect(composeText).toContain("no-new-privileges:true");
      expect(service.restart, `${name} restart policy`).toBe("unless-stopped");
      expect(service.healthcheck, `${name} health check`).toBeTruthy();
      expect(service.deploy?.resources?.limits?.cpus, `${name} CPU limit`).toBeTruthy();
      expect(service.deploy?.resources?.limits?.memory, `${name} memory limit`).toBeTruthy();
      expect(service.pids_limit, `${name} process limit`).toBeGreaterThan(0);
    }
    expect(compose.services.caddy.cap_add).toContain("NET_BIND_SERVICE");
  });

  it("requires Redis authentication and has no secret defaults or demo values", () => {
    expect(compose.services.redis.command?.join(" ")).toContain("--requirepass");
    expect(compose.services.redis.environment?.REDIS_PASSWORD).toMatch(
      /^\$\{REDIS_PASSWORD:\?/,
    );
    expect(compose.services.backend.environment?.REDIS_URL).toMatch(
      /\$\{REDIS_PASSWORD:\?/,
    );
    expect(compose.services.backend.environment?.REDIS_URL).not.toContain(":-");
    expect(compose.services.backend.env_file).toContain(".env.production");
    expect(compose.services.worker.env_file).toContain(".env.production");

    const env = exampleEnvironment();
    const interpolatedNames = Array.from(
      composeText.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g),
      (match) => match[1],
    );
    for (const name of interpolatedNames) {
      expect(env, `${name} is documented in the production env template`).toHaveProperty(name);
    }
    const secretEntries = Object.entries(env).filter(([name]) => secretLike(name));
    expect(secretEntries.length).toBeGreaterThan(0);
    expect(secretEntries.filter(([, value]) => value !== "")).toEqual([]);
    for (const [name, value] of secretEntries) {
      const report = evaluateProductionConfiguration({
        NODE_ENV: "production",
        [name]: value,
      } as NodeJS.ProcessEnv);
      expect(report.errors.some((error) => /demo\/default value/.test(error))).toBe(false);
    }

    const safeValuesReport = evaluateProductionConfiguration({
      ...env,
      NODE_ENV: "production",
      SUPABASE_URL: "https://tenant.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "synthetic-publishable-key-that-is-not-a-demo-value",
      SUPABASE_SECRET_KEY: "synthetic-service-role-key-that-is-not-a-demo-value",
      JWT_SECRET: "j".repeat(48),
      DOWNLOAD_SIGNING_SECRET: "d".repeat(48),
      USER_API_KEYS_ENCRYPTION_SECRET: "u".repeat(48),
      MCP_CONNECTORS_ENCRYPTION_SECRET: "m".repeat(48),
      AUTH_HANDOFF_ENCRYPTION_SECRET: "h".repeat(48),
      FRONTEND_URL: "https://app.vaultr.test",
      WORD_ADDIN_URL: "https://word.vaultr.test",
      API_PUBLIC_URL: "https://app.vaultr.test/api",
      ALLOWED_ORIGINS: "https://app.vaultr.test,https://word.vaultr.test",
      R2_ENDPOINT_URL: "https://storage.vaultr.test",
      R2_BUCKET_NAME: "private-documents",
      R2_ACCESS_KEY_ID: "synthetic-storage-access-id",
      R2_SECRET_ACCESS_KEY: "synthetic-storage-secret-key",
      REDIS_URL: "redis://:synthetic-redis-password@redis:6379/0",
    } as NodeJS.ProcessEnv);
    expect(safeValuesReport.errors).toEqual([]);

    expect(composeText).not.toMatch(/(?:PASSWORD|SECRET|TOKEN|ACCESS_KEY|API_KEY)\s*:\s*[^\n]*:-[^\n]+/i);
    expect(composeText).not.toMatch(/(?:password|secret|token)\s*[:=]\s*(?:postgres|admin|password|secret|demo|change-me)/i);
  });

  it("gives every production environment setting its own plain-language description", () => {
    const lines = envText.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (!/^[A-Z][A-Z0-9_]*=/.test(line)) continue;
      expect(lines[index - 1], line.split("=", 1)[0]).toMatch(/^# .+\S$/);
    }
  });

  it("matches Caddy's single sanitized forwarding hop to TRUST_PROXY_HOPS=1", () => {
    expect(exampleEnvironment().TRUST_PROXY_HOPS).toBe("1");
    expect(compose.services.backend.environment?.TRUST_PROXY_HOPS).toMatch(
      /^\$\{TRUST_PROXY_HOPS:\?/,
    );
    expect(caddyText).toContain("header_up X-Forwarded-For {remote_host}");
    for (const name of [
      "X-Real-IP",
      "Forwarded",
      "CF-Connecting-IP",
      "True-Client-IP",
    ]) {
      expect(caddyText).toContain(`header_up -${name}`);
    }
    expect(caddyText).not.toMatch(/trusted_proxies|proxy_protocol/i);
    expect(caddyText).toContain("reverse_proxy frontend:3000");
    expect(caddyText).toContain("reverse_proxy word-addin:3200");
  });

  it("redirects HTTP, applies the public security-header baseline, and preserves app CSP", () => {
    expect(caddyText).toContain("http://{$APP_HOST}, http://{$WORD_HOST}");
    expect(caddyText).toContain("redir https://{host}{uri} 308");
    expect(caddyText).toContain("Strict-Transport-Security");
    expect(caddyText).toContain("X-Content-Type-Options nosniff");
    expect(caddyText).toContain("Referrer-Policy no-referrer");
    expect(caddyText).toContain("X-Frame-Options DENY");
    expect(caddyText).toContain("Permissions-Policy");
    const appSiteStart = caddyText.indexOf("\n{$APP_HOST} {");
    const wordSiteStart = caddyText.lastIndexOf("\n{$WORD_HOST} {");
    const appSite =
      appSiteStart >= 0 && wordSiteStart > appSiteStart
        ? caddyText.slice(appSiteStart, wordSiteStart)
        : "";
    const wordSite = wordSiteStart >= 0 ? caddyText.slice(wordSiteStart) : "";
    expect(appSite).not.toMatch(/^\s*Content-Security-Policy/m);
    expect(appSite).toContain("X-Frame-Options DENY");
    expect(wordSite).toContain("Content-Security-Policy");
    expect(wordSite).not.toMatch(/^\s*X-Frame-Options\b/m);
    expect(wordSite).toContain("https://appsforoffice.microsoft.com");
    expect(wordSite).toContain("frame-ancestors https://*.office.com");
    expect(compose.services.caddy.environment?.WORD_ADDIN_CSP_CONNECT_ORIGINS).toMatch(
      /^\$\{WORD_ADDIN_CSP_CONNECT_ORIGINS:-\}$/,
    );
    expect(compose.services.backend.environment?.NODE_ENV).toBe("production");
    expect(compose.services.backend.environment?.WORKERS_MODE).toBe("none");
  });

  it("applies parser-sized request caps and low-latency bounded streaming", () => {
    expect(caddyText.match(/max_size 256KiB/g)).toHaveLength(2);
    expect(caddyText.match(/max_size 1MiB/g)).toHaveLength(2);
    expect(caddyText.match(/max_size 2MiB/g)).toHaveLength(2);
    expect(caddyText).toContain("read_body_idle 30s");
    expect(caddyText).toContain("write_idle 3m");
    expect(caddyText).toContain("write 16m");
    expect(caddyText.match(/flush_interval -1/g)?.length).toBeGreaterThanOrEqual(6);
    expect(caddyText.match(/stream_timeout 16m/g)?.length).toBeGreaterThanOrEqual(6);
    expect(caddyText).not.toMatch(/response_buffers|request_buffers/i);
  });
});
