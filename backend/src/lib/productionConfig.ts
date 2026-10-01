import { createHash } from "node:crypto";
import net from "node:net";
import { isAllowlistablePrivateIp, isBlockedIp, isLoopbackIp } from "./privateIp";

type ConfigurationReport = { errors: string[]; warnings: string[] };
type Environment = NodeJS.ProcessEnv;

// SHA-256 fingerprints of secret-like values shipped as local examples or
// Compose defaults. Keeping fingerprints lets boot reject those values while
// neither storing nor logging the credential text here.
const CHECKED_IN_DEMO_SECRET_FINGERPRINTS = new Set([
  "bf1725a8f98bea37e88618702e725ba84bd8acdb2647c5e0ed638bfd685791cf",
  "471c56db27a3e7e6fb9d1115a0ca237ede4c8f5807175c6b084b1e3354288a9b",
  "d7dd10dde979c9653bcef92500cd20478fd42d6c7b79c05cd7cc2473d0a9e728",
  "a9674dd00cb1e57a97ef79fbdaec4bf2be3c66b01bbb6c5a1a43433e5b69e5e8",
  "2839ad0f46d051cd99d6af0fa92df975d4c72c1d657f2cb782d9ef9a70736737",
  "f9d2fc8b8a2fbf601b9aed45bc1286ed1e1a74b4596643b259a7164d0e89c8d7",
  "71e46c8211f916ee07b6312c8c00b00872b6d7104e51b38125e3a7f870dc1403",
  "53e99f02c967fabb18fff34df4ffeeaf41080fb51f54665fda15f5f837e38d90",
  "bfe3d426fcfcfa827e8f3353e608db55bfbd3693e71e99fd093146a41ac339df",
  "711bf47401a7e7963e00afe306560e2d922bcd44d21ce70832904e2bcef7ab34",
  "fb90f874cd2587f862194c7d51143cd8ed1a5e670292d8573ae7e7e51e06dff7",
  "a942b37ccfaf5a813b1432caa209a43b9d144e47ad0de1549c289c253e556cd5",
  "a064b502e61d27e94b8717290e5e1b32e36720e9fbdf952ec81a84c07128cb37",
  "8af148c12025605462afec24074be14fb4781056573d5490e6282dc1d977981f",
  "70541e07fd4f900b66e289f5be55c85f9bef1def4924a5b0c518c45ea1688c12",
]);

const SECRET_LIKE_NAME =
  /(?:_SECRET(?:_|$)|_PASSWORD(?:_|$)|_TOKEN(?:_|$)|_API_KEY(?:_|$)|_ACCESS_KEY(?:_ID)?(?:_|$)|_PUBLISHABLE_KEY(?:_|$)|_ANON_KEY(?:_|$)|_SERVICE_ROLE_KEY(?:_|$)|_PRIVATE_KEY(?:_|$)|JWT_SECRET$)/i;
const DEBUG_ENABLED = /^(?:1|true|yes|on)$/i;
const METADATA_HOSTS = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.azure.internal",
  "instance-data.ec2.internal",
]);

function fingerprint(value: string): string {
  return createHash("sha256").update(value.trim()).digest("hex");
}

function isKnownDemoSecret(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) return false;
  if (CHECKED_IN_DEMO_SECRET_FINGERPRINTS.has(fingerprint(normalized))) return true;
  return /^(?:your(?:[-_ ]|$)|change(?:[-_ ]?me)?(?:[-_ ]|$)|replace(?:[-_ ]?me)?(?:[-_ ]|$)|demo(?:[-_ ]|$)|default(?:[-_ ]|$)|example(?:[-_.]|$)|placeholder(?:[-_ ]|$)|not[-_ ]?a[-_ ]?real(?:[-_ ]|$)|<[^>]+>)/i.test(
    normalized,
  );
}

function configured(value: string | undefined): string {
  return value?.trim() ?? "";
}

function hostnameIsLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    (net.isIP(host) === 4 && isLoopbackIp(host)) ||
    (net.isIP(host) === 6 && isLoopbackIp(host))
  );
}

function isLoopbackUrl(url: URL): boolean {
  return hostnameIsLoopback(url.hostname);
}

function parseHttpUrl(
  name: string,
  value: string,
  errors: string[],
): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      errors.push(`${name} must use http or https`);
      return null;
    }
    if (!url.hostname || url.username || url.password) {
      errors.push(`${name} must be an absolute URL without embedded credentials`);
      return null;
    }
    return url;
  } catch {
    errors.push(`${name} must be an absolute URL`);
    return null;
  }
}

function requireSecureUrl(name: string, value: string, errors: string[]): URL | null {
  const url = parseHttpUrl(name, value, errors);
  if (url && url.protocol !== "https:" && !isLoopbackUrl(url)) {
    errors.push(`${name} must use https outside loopback`);
  }
  return url;
}

function isMetadataOrBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (
    METADATA_HOSTS.has(host) ||
    host.endsWith(".metadata.google.internal") ||
    host.endsWith(".metadata.azure.internal")
  ) {
    return true;
  }
  if (net.isIP(host)) {
    return (
      isBlockedIp(host) &&
      !isLoopbackIp(host) &&
      !isAllowlistablePrivateIp(host)
    );
  }
  return false;
}

function checkPrivateEndpointAllowlist(value: string, name: string, errors: string[]) {
  for (const entry of value.split(",").map((item) => item.trim()).filter(Boolean)) {
    if (entry.includes("*") || /\/\d{1,3}$/.test(entry)) {
      errors.push(`${name} must contain exact origins, not wildcards or address ranges`);
      continue;
    }
    const url = parseHttpUrl(name, entry, errors);
    if (!url) continue;
    if (isMetadataOrBlockedHost(url.hostname)) {
      errors.push(`${name} must not include link-local, metadata, or reserved addresses`);
    }
  }
}

function checkCorsOrigins(env: Environment, errors: string[]) {
  const explicit = configured(env.ALLOWED_ORIGINS)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const candidates = [
    ...(configured(env.FRONTEND_URL) ? [configured(env.FRONTEND_URL)] : []),
    ...(configured(env.WORD_ADDIN_URL) ? [configured(env.WORD_ADDIN_URL)] : []),
    ...explicit,
  ];
  if (candidates.length === 0) {
    errors.push("ALLOWED_ORIGINS or FRONTEND_URL must configure at least one origin");
  }
  if (configured(env.ALLOWED_ORIGINS) === "*") {
    errors.push("ALLOWED_ORIGINS must contain exact origins; wildcard origins are not allowed");
  }
  for (const [index, origin] of candidates.entries()) {
    const name = index < (configured(env.FRONTEND_URL) ? 1 : 0)
      ? "FRONTEND_URL"
      : index <
          (configured(env.FRONTEND_URL) ? 1 : 0) +
            (configured(env.WORD_ADDIN_URL) ? 1 : 0)
        ? "WORD_ADDIN_URL"
        : "ALLOWED_ORIGINS";
    if (origin.includes("*") || origin === "null") {
      errors.push(`${name} must contain exact origins; wildcards are not allowed`);
      continue;
    }
    const url = requireSecureUrl(name, origin, errors);
    if (!url) continue;
    if (url.pathname !== "/" || url.search || url.hash) {
      errors.push(`${name} entries must be origins without a path, query, or fragment`);
    }
  }
}

function checkWordCspConnectOrigins(value: string, errors: string[]) {
  for (const origin of value.split(/\s+/).map((item) => item.trim()).filter(Boolean)) {
    if (origin.includes("*")) {
      errors.push("WORD_ADDIN_CSP_CONNECT_ORIGINS must contain exact HTTPS origins, not wildcards");
      continue;
    }
    const url = parseHttpUrl("WORD_ADDIN_CSP_CONNECT_ORIGINS", origin, errors);
    if (!url) continue;
    if (url.protocol !== "https:") {
      errors.push("WORD_ADDIN_CSP_CONNECT_ORIGINS entries must use https");
    }
    if (url.pathname !== "/" || url.search || url.hash) {
      errors.push("WORD_ADDIN_CSP_CONNECT_ORIGINS entries must be origins without a path");
    }
  }
}

function checkRateLimitConfiguration(env: Environment, errors: string[]) {
  for (const [name, raw] of Object.entries(env)) {
    if (!name.startsWith("RATE_LIMIT_") || raw === undefined || !raw.trim()) continue;
    if (/(?:DISABLE|DISABLED)$/.test(name) && DEBUG_ENABLED.test(raw.trim())) {
      errors.push(`${name} must be disabled in production`);
    }
    if (/(?:ENABLE|ENABLED)$/.test(name) && /^(?:0|false|no|off)$/i.test(raw.trim())) {
      errors.push(`${name} must remain enabled in production`);
    }
    if (!/(?:_MAX(?:_PER_HOUR)?|_WINDOW_(?:MINUTES|HOURS|MS))$/.test(name)) continue;
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      errors.push(`${name} must be a positive finite integer`);
    }
  }
}

function evaluate(env: Environment): ConfigurationReport {
  if (env.NODE_ENV !== "production") return { errors: [], warnings: [] };

  const errors: string[] = [];
  const warnings: string[] = [];
  const requireValue = (name: string): string => {
    const value = configured(env[name]);
    if (!value) errors.push(`${name} is required in production`);
    return value;
  };
  const requireMinimum = (name: string, minimum: number): string => {
    const value = requireValue(name);
    if (value && value.length < minimum) {
      errors.push(`${name} must contain at least ${minimum} characters`);
    }
    return value;
  };

  for (const [name, value] of Object.entries(env)) {
    if (value?.trim() && SECRET_LIKE_NAME.test(name) && isKnownDemoSecret(value)) {
      errors.push(`${name} must not use a checked-in demo/default value`);
    }
  }

  const serviceKey = requireMinimum("SUPABASE_SECRET_KEY", 32);
  const publishableKey = configured(env.SUPABASE_PUBLISHABLE_KEY) ||
    configured(env.SUPABASE_ANON_KEY);
  if (!publishableKey) {
    errors.push("SUPABASE_PUBLISHABLE_KEY or SUPABASE_ANON_KEY is required in production");
  }
  if (serviceKey && publishableKey && serviceKey === publishableKey) {
    errors.push("SUPABASE_SECRET_KEY must differ from the publishable/anon key");
  }
  requireMinimum("JWT_SECRET", 32);
  requireMinimum("DOWNLOAD_SIGNING_SECRET", 32);
  requireMinimum("USER_API_KEYS_ENCRYPTION_SECRET", 32);
  const mcpEncryptionSecret = configured(env.MCP_CONNECTORS_ENCRYPTION_SECRET);
  if (mcpEncryptionSecret) {
    if (mcpEncryptionSecret.length < 32) {
      errors.push("MCP_CONNECTORS_ENCRYPTION_SECRET must contain at least 32 characters");
    }
  } else {
    warnings.push(
      "MCP_CONNECTORS_ENCRYPTION_SECRET is not set; MCP/OAuth data uses USER_API_KEYS_ENCRYPTION_SECRET. Set a separate key for isolation.",
    );
  }
  const handoffSecret = configured(env.AUTH_HANDOFF_ENCRYPTION_SECRET);
  if (configured(env.WORD_ADDIN_URL) && !handoffSecret) {
    errors.push("AUTH_HANDOFF_ENCRYPTION_SECRET is required when WORD_ADDIN_URL is set");
  }
  if (handoffSecret && handoffSecret.length < 32) {
    errors.push("AUTH_HANDOFF_ENCRYPTION_SECRET must contain at least 32 characters");
  }

  const trustProxyHops = configured(env.TRUST_PROXY_HOPS);
  if (!trustProxyHops) {
    errors.push("TRUST_PROXY_HOPS must be explicitly set; use 0 only with no trusted proxy");
  } else if (!/^\d+$/.test(trustProxyHops) || Number(trustProxyHops) > 16) {
    errors.push("TRUST_PROXY_HOPS must be a non-negative integer no greater than 16");
  }

  const supabaseUrl = requireValue("SUPABASE_URL");
  if (supabaseUrl) {
    const url = parseHttpUrl("SUPABASE_URL", supabaseUrl, errors);
    if (url && isLoopbackUrl(url)) {
      errors.push("SUPABASE_URL must not point to localhost or loopback in production");
    } else if (url && url.protocol !== "https:") {
      errors.push("SUPABASE_URL must use https in production");
    }
    if (url && /(?:^|[.-])(?:supabase-)?demo(?:[.-]|$)/i.test(url.hostname)) {
      errors.push("SUPABASE_URL must not point to a demo project");
    }
  }

  const frontendUrl = requireValue("FRONTEND_URL");
  if (frontendUrl) requireSecureUrl("FRONTEND_URL", frontendUrl, errors);
  const apiPublicUrl = requireValue("API_PUBLIC_URL");
  if (apiPublicUrl) requireSecureUrl("API_PUBLIC_URL", apiPublicUrl, errors);
  const wordAddinUrl = configured(env.WORD_ADDIN_URL);
  if (wordAddinUrl) requireSecureUrl("WORD_ADDIN_URL", wordAddinUrl, errors);
  checkCorsOrigins(env, errors);
  checkWordCspConnectOrigins(
    configured(env.WORD_ADDIN_CSP_CONNECT_ORIGINS),
    errors,
  );

  const storageEndpoint = requireValue("R2_ENDPOINT_URL");
  if (storageEndpoint) requireSecureUrl("R2_ENDPOINT_URL", storageEndpoint, errors);
  requireValue("R2_BUCKET_NAME");
  requireValue("R2_ACCESS_KEY_ID");
  requireValue("R2_SECRET_ACCESS_KEY");
  const publicStorageEndpoint = configured(env.R2_PUBLIC_ENDPOINT_URL);
  if (publicStorageEndpoint) {
    requireSecureUrl("R2_PUBLIC_ENDPOINT_URL", publicStorageEndpoint, errors);
  }

  for (const name of [
    "OPENROUTER_BASE_URL",
    "VERCEL_AI_GATEWAY_BASE_URL",
    "OPENCODE_GO_BASE_URL",
  ]) {
    const value = configured(env[name]);
    if (value) requireSecureUrl(name, value, errors);
  }

  checkRateLimitConfiguration(env, errors);
  for (const name of [
    "DEBUG_LLM_TOOL_CALLS",
    "LOG_RAW_LLM_STREAM",
    "SENTRY_DEBUG",
    "SENTRY_ENABLE_TEST_ROUTE",
    "SENTRY_ALLOW_IN_TESTS",
    "VERBOSE_ERRORS",
    "SHOW_ERROR_DETAILS",
    "SHOW_STACK_TRACES",
  ]) {
    if (DEBUG_ENABLED.test(configured(env[name]))) {
      errors.push(`${name} must be disabled in production`);
    }
  }

  checkPrivateEndpointAllowlist(
    configured(env.MODEL_PRIVATE_ENDPOINT_ALLOWLIST),
    "MODEL_PRIVATE_ENDPOINT_ALLOWLIST",
    errors,
  );

  const replicasRaw = configured(env.API_REPLICAS);
  const replicas = replicasRaw ? Number(replicasRaw) : 1;
  if (replicasRaw && (!/^\d+$/.test(replicasRaw) || replicas < 1 || replicas > 100)) {
    errors.push("API_REPLICAS must be an integer from 1 to 100");
  }

  const redisUrl = configured(env.REDIS_URL);
  if (!redisUrl) {
    warnings.push(
      "REDIS_URL is not explicit; configure a shared Redis URL before scaling API replicas or relying on shared rate limits.",
    );
  } else {
    try {
      const url = new URL(redisUrl);
      if (!/^rediss?:$/.test(url.protocol) || !url.hostname) {
        errors.push("REDIS_URL must be an absolute redis or rediss URL");
      } else if (!url.password && url.protocol !== "rediss:" && !hostnameIsLoopback(url.hostname)) {
        warnings.push(
          "REDIS_URL has no password or TLS for a non-loopback host; configure Redis authentication or rediss TLS.",
        );
      }
    } catch {
      errors.push("REDIS_URL must be an absolute redis or rediss URL");
    }
  }
  if (replicas > 1 && !redisUrl) {
    warnings.push("API_REPLICAS is greater than 1 without REDIS_URL; rate-limit counters may diverge between replicas.");
  }
  if (!configured(env.SENTRY_DSN)) {
    warnings.push("SENTRY_DSN is not set; production backend errors will not reach an error-reporting service.");
  }

  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

/** Pure production-only preflight; local and test environments are unchanged. */
export function evaluateProductionConfiguration(
  env: Environment = process.env,
): ConfigurationReport {
  return evaluate(env);
}

/** Validate fail-fast rules and emit all optional-setting warnings once. */
export function validateProductionConfiguration(
  env: Environment = process.env,
  warn: (message: string) => void = (message) => console.warn(message),
): void {
  const report = evaluate(env);
  if (report.errors.length) {
    throw Object.assign(
      new Error(
        `Production configuration is unsafe:\n- ${report.errors.join("\n- ")}`,
      ),
      {
        code: "production_configuration_invalid",
        configurationFields: report.errors.map((issue) => issue.match(/^[A-Z_]+/)?.[0]),
      },
    );
  }
  if (report.warnings.length) {
    warn(`[production-config] Review these settings:\n- ${report.warnings.join("\n- ")}`);
  }
}
