import { createHash } from "node:crypto";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import type {
  ClientRateLimitInfo,
  IncrementResponse,
  Options,
  RateLimitRequestHandler,
  Store,
} from "express-rate-limit";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { envInt, uploadSessionRateLimitConfiguration } from "./runtimeConfig";
import { getRedisRateLimitConnection } from "./queue/connection";

export type RateLimitClass =
  | "general"
  | "chat"
  | "chatCreate"
  | "toolResult"
  | "export"
  | "workflowImport"
  | "dataDelete"
  | "uploadMutation"
  | "uploadPolling"
  | "uploadCreate"
  | "authLoginIp"
  | "authLoginIdentifierIp"
  | "authEmailIp"
  | "authSignupIdentifierIp"
  | "authResetIdentifierIp"
  | "authFlow"
  | "authMfa";

type RateLimitScope = "user" | "ip" | "identifier-ip";
type StoreErrorPolicy = "closed" | "open";

type CounterConfig = {
  name: RateLimitClass;
  scope: RateLimitScope;
  windowMs: number;
  limit: number;
  errorPolicy: StoreErrorPolicy;
  message?: string;
  skipSuccessfulRequests?: boolean;
  identifierAction?: "signup" | "password-reset" | "login";
};

export class RateLimitStoreUnavailableError extends Error {
  readonly limiterName: string;

  constructor(limiterName: string) {
    super("Rate-limit store unavailable");
    this.name = "RateLimitStoreUnavailableError";
    this.limiterName = limiterName;
  }
}

type MemoryEntry = { totalHits: number; resetTime: Date };
type MemoryState = Map<string, MemoryEntry>;

const processMemoryState: MemoryState = new Map();
const DEFAULT_MEMORY_KEY_LIMIT = 10_000;
const memoryKeyLimit = () =>
  envInt("RATE_LIMIT_MEMORY_MAX_KEYS", DEFAULT_MEMORY_KEY_LIMIT);

/**
 * A process-wide, cardinality-bounded fallback store. Expired entries are
 * purged before a new key is admitted; active entries are never evicted to
 * make room, because eviction would silently grant more requests.
 */
export class BoundedMemoryRateLimitStore implements Store {
  localKeys = true;
  private windowMs = 60_000;

  constructor(
    private readonly options: {
      namespace: string;
      maxKeys?: number;
      now?: () => number;
      state?: MemoryState;
    },
  ) {}

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  get(key: string): ClientRateLimitInfo | undefined {
    const current = this.lookup(key, this.now());
    return current ? { totalHits: current.totalHits, resetTime: current.resetTime } : undefined;
  }

  increment(key: string): IncrementResponse {
    const now = this.now();
    const state = this.state();
    const namespacedKey = this.key(key);
    let entry = state.get(namespacedKey);
    if (entry && entry.resetTime.getTime() <= now) {
      state.delete(namespacedKey);
      entry = undefined;
    }

    if (!entry) {
      this.purgeExpired(now);
      if (state.size >= this.maxKeys()) {
        throw new RateLimitStoreUnavailableError(this.options.namespace);
      }
      entry = { totalHits: 0, resetTime: new Date(now + this.windowMs) };
      state.set(namespacedKey, entry);
    }

    entry.totalHits += 1;
    return { totalHits: entry.totalHits, resetTime: entry.resetTime };
  }

  decrement(key: string): void {
    const entry = this.lookup(key, this.now());
    if (entry && entry.totalHits > 0) entry.totalHits -= 1;
  }

  resetKey(key: string): void {
    this.state().delete(this.key(key));
  }

  resetAll(): void {
    const prefix = `${this.options.namespace}:`;
    for (const key of this.state().keys()) {
      if (key.startsWith(prefix)) this.state().delete(key);
    }
  }

  keyCount(): number {
    return this.state().size;
  }

  private lookup(key: string, now: number): MemoryEntry | undefined {
    const entry = this.state().get(this.key(key));
    if (entry && entry.resetTime.getTime() <= now) {
      this.state().delete(this.key(key));
      return undefined;
    }
    return entry;
  }

  private purgeExpired(now: number): void {
    for (const [key, entry] of this.state()) {
      if (entry.resetTime.getTime() <= now) this.state().delete(key);
    }
  }

  private state(): MemoryState {
    return this.options.state ?? processMemoryState;
  }

  private key(key: string): string {
    return `${this.options.namespace}:${key}`;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private maxKeys(): number {
    return Math.max(1, this.options.maxKeys ?? memoryKeyLimit());
  }
}

type RedisRateLimitClient = {
  eval: (script: string, numberOfKeys: number, ...args: Array<string | number>) => Promise<unknown>;
};

const REDIS_INCREMENT_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  ttl = tonumber(ARGV[1])
  redis.call('PEXPIRE', KEYS[1], ttl)
end
return { hits, ttl }
`;

const REDIS_READ_SCRIPT = `
local hits = redis.call('GET', KEYS[1])
if not hits then return { 0, -2 } end
return { tonumber(hits), redis.call('PTTL', KEYS[1]) }
`;

const REDIS_DECREMENT_SCRIPT = `
local hits = redis.call('GET', KEYS[1])
if not hits then return 0 end
hits = redis.call('DECR', KEYS[1])
if hits <= 0 then redis.call('DEL', KEYS[1]) end
return hits
`;

/** Atomic Redis counter with fixed-window expiry, shared by API instances. */
export class RedisRateLimitStore implements Store {
  localKeys = false;
  private windowMs = 60_000;

  constructor(
    private readonly client: RedisRateLimitClient,
    private readonly namespace: string,
    private readonly now: () => number = Date.now,
  ) {}

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    try {
      const [hits, ttl] = (await this.client.eval(
        REDIS_READ_SCRIPT,
        1,
        this.key(key),
      )) as [number, number];
      if (Number(hits) <= 0 || Number(ttl) < 0) return undefined;
      return {
        totalHits: Number(hits),
        resetTime: new Date(this.now() + Number(ttl)),
      };
    } catch {
      throw new RateLimitStoreUnavailableError(this.namespace);
    }
  }

  async increment(key: string): Promise<IncrementResponse> {
    try {
      const [hits, ttl] = (await this.client.eval(
        REDIS_INCREMENT_SCRIPT,
        1,
        this.key(key),
        Math.max(1, this.windowMs),
      )) as [number, number];
      return {
        totalHits: Number(hits),
        resetTime: new Date(this.now() + Math.max(0, Number(ttl))),
      };
    } catch {
      throw new RateLimitStoreUnavailableError(this.namespace);
    }
  }

  async decrement(key: string): Promise<void> {
    // Skip-success counters are best-effort cleanup after the HTTP response
    // has finished. A cleanup failure must not create an unhandled rejection;
    // the counter remains conservative until its TTL expires.
    try {
      await this.client.eval(REDIS_DECREMENT_SCRIPT, 1, this.key(key));
    } catch {
      throw new RateLimitStoreUnavailableError(this.namespace);
    }
  }

  async resetKey(key: string): Promise<void> {
    try {
      await this.client.eval("return redis.call('DEL', KEYS[1])", 1, this.key(key));
    } catch {
      throw new RateLimitStoreUnavailableError(this.namespace);
    }
  }

  private key(key: string): string {
    return `vaultr:rate-limit:${this.namespace}:${key}`;
  }
}

export type RateLimitStoreMode = "redis" | "memory";

/**
 * Process-wide breaker shared by every limiter store. A single in-flight probe
 * tests Redis after the cooldown; other concurrent requests stay on their
 * bounded local counters until that probe succeeds or fails.
 */
export class RedisRateLimitCircuitBreaker {
  private failures = 0;
  private openedUntil = 0;
  private probeInFlight = false;

  constructor(
    private readonly options: {
      failureThreshold: number;
      cooldownMs: number;
      now?: () => number;
    },
  ) {}

  get mode(): RateLimitStoreMode {
    return this.now() < this.openedUntil ? "memory" : "redis";
  }

  async run<T>(
    redisOperation: () => Promise<T>,
    memoryOperation: () => T | Promise<T>,
    onFailure: () => void,
  ): Promise<T> {
    const now = this.now();
    if (now < this.openedUntil || this.probeInFlight) {
      return memoryOperation();
    }

    const probe = this.openedUntil > 0;
    if (probe) this.probeInFlight = true;
    try {
      const result = await redisOperation();
      this.failures = 0;
      this.openedUntil = 0;
      return result;
    } catch {
      this.failures += 1;
      if (probe || this.failures >= Math.max(1, this.options.failureThreshold)) {
        this.openedUntil = this.now() + Math.max(1, this.options.cooldownMs);
      }
      onFailure();
      return memoryOperation();
    } finally {
      if (probe) this.probeInFlight = false;
    }
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

type ResilientRateLimitStoreOptions = {
  redis: Store;
  memory: Store;
  breaker: RedisRateLimitCircuitBreaker;
  limiterName: string;
  onDegraded: (event: { limiter: string; reason: string; mode: RateLimitStoreMode }) => void;
};

/** Redis-first store that continues with bounded per-process counters on error. */
export class ResilientRateLimitStore implements Store {
  // The primary store is shared when healthy; `localKeys` remains false so
  // express-rate-limit does not mistake temporary fallback for a pure local
  // configuration and reject construction under a distributed-store setup.
  localKeys = false;

  constructor(private readonly options: ResilientRateLimitStoreOptions) {}

  init(options: Options): void {
    this.options.redis.init?.(options);
    this.options.memory.init?.(options);
  }

  get(key: string): Promise<ClientRateLimitInfo | undefined> {
    return this.run(
      () => Promise.resolve(this.options.redis.get?.(key)),
      () => this.options.memory.get?.(key),
    );
  }

  increment(key: string): Promise<IncrementResponse> {
    return this.run(
      () => Promise.resolve(this.options.redis.increment(key)),
      () => this.options.memory.increment(key),
    );
  }

  async decrement(key: string): Promise<void> {
    await this.run(
      async () => {
        await this.options.redis.decrement?.(key);
      },
      async () => {
        await this.options.memory.decrement?.(key);
      },
    );
  }

  async resetKey(key: string): Promise<void> {
    await this.run(
      async () => {
        await this.options.redis.resetKey(key);
      },
      async () => {
        await this.options.memory.resetKey(key);
      },
    );
  }

  private run<T>(redisOperation: () => Promise<T>, memoryOperation: () => T | Promise<T>): Promise<T> {
    return this.options.breaker.run(redisOperation, memoryOperation, () => {
      this.options.onDegraded({
        limiter: this.options.limiterName,
        reason: "Redis rate-limit operation failed",
        mode: "memory",
      });
    });
  }
}

let lastStoreWarningAt = 0;
function logStoreDegraded(limiterName: string, reason: string, mode: RateLimitStoreMode = "memory"): void {
  const now = Date.now();
  if (now - lastStoreWarningAt < 60_000) return;
  lastStoreWarningAt = now;
  console.warn("[rate-limit] store degraded", {
    limiter: limiterName,
    reason,
    mode,
  });
}

export function usesSharedRateLimitStore(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(
    env.REDIS_URL?.trim() ||
      env.QUEUE_DRIVER === "redis" ||
      env.ASYNC_DOCUMENT_CONVERSION === "true" ||
      env.ASYNC_TABULAR_EXTRACTION === "true",
  );
}

export function warnForProcessLocalProductionRateLimits(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.NODE_ENV !== "production" || usesSharedRateLimitStore(env)) return;
  console.warn(
    "[rate-limit] production counters are process-local; run one API process or configure REDIS_URL for shared atomic limits. In-memory counters reset on restart.",
  );
}

type CounterDefinition = Omit<CounterConfig, "scope">;

function minutes(value: number): number {
  return value * 60_000;
}

function hours(value: number): number {
  return value * 60 * 60_000;
}

function perUserMax(name: RateLimitClass): number {
  switch (name) {
    case "general":
      return envInt("RATE_LIMIT_GENERAL_MAX", 300);
    case "chat":
      return envInt("RATE_LIMIT_CHAT_MAX", 30);
    case "chatCreate":
      return envInt("RATE_LIMIT_CHAT_CREATE_MAX", 60);
    case "toolResult":
      return envInt("RATE_LIMIT_TOOL_RESULT_MAX", 2_000);
    case "export":
      return envInt("RATE_LIMIT_EXPORT_MAX", 10);
    case "workflowImport":
      return envInt("RATE_LIMIT_UPLOAD_MAX", 50);
    case "dataDelete":
      return envInt("RATE_LIMIT_DATA_DELETE_MAX", 20);
    case "uploadMutation":
      return uploadSessionRateLimitConfiguration().mutationMax;
    case "uploadPolling":
      return uploadSessionRateLimitConfiguration().pollingMax;
    case "uploadCreate":
      return uploadSessionRateLimitConfiguration().sessionCreationMaxPerHour;
    case "authLoginIp":
    case "authLoginIdentifierIp":
      return name === "authLoginIp"
        ? envInt("RATE_LIMIT_AUTH_LOGIN_MAX", 100)
        : envInt("RATE_LIMIT_AUTH_ACCOUNT_MAX", 10);
    case "authEmailIp":
    case "authSignupIdentifierIp":
    case "authResetIdentifierIp":
      return envInt("RATE_LIMIT_AUTH_EMAIL_MAX", 10);
    case "authFlow":
      return envInt("RATE_LIMIT_AUTH_FLOW_MAX", 30);
    case "authMfa":
      return envInt("RATE_LIMIT_AUTH_MFA_MAX", 20);
  }
}

function windowMs(name: RateLimitClass): number {
  switch (name) {
    case "general":
      return minutes(envInt("RATE_LIMIT_GENERAL_WINDOW_MINUTES", 15));
    case "chat":
      return minutes(envInt("RATE_LIMIT_CHAT_WINDOW_MINUTES", 15));
    case "chatCreate":
      return minutes(envInt("RATE_LIMIT_CHAT_CREATE_WINDOW_MINUTES", 15));
    case "toolResult":
      return minutes(envInt("RATE_LIMIT_TOOL_RESULT_WINDOW_MINUTES", 15));
    case "export":
      return hours(envInt("RATE_LIMIT_EXPORT_WINDOW_HOURS", 1));
    case "workflowImport":
      return hours(envInt("RATE_LIMIT_UPLOAD_WINDOW_HOURS", 1));
    case "dataDelete":
      return hours(envInt("RATE_LIMIT_DATA_DELETE_WINDOW_HOURS", 1));
    case "uploadMutation":
      return minutes(uploadSessionRateLimitConfiguration().mutationWindowMinutes);
    case "uploadPolling":
      return minutes(uploadSessionRateLimitConfiguration().pollingWindowMinutes);
    case "uploadCreate":
      return hours(1);
    case "authLoginIp":
    case "authLoginIdentifierIp":
      return minutes(
        envInt(
          name === "authLoginIp"
            ? "RATE_LIMIT_AUTH_LOGIN_WINDOW_MINUTES"
            : "RATE_LIMIT_AUTH_ACCOUNT_WINDOW_MINUTES",
          15,
        ),
      );
    case "authEmailIp":
    case "authSignupIdentifierIp":
    case "authResetIdentifierIp":
      return hours(envInt("RATE_LIMIT_AUTH_EMAIL_WINDOW_HOURS", 1));
    case "authFlow":
      return minutes(envInt("RATE_LIMIT_AUTH_FLOW_WINDOW_MINUTES", 15));
    case "authMfa":
      return minutes(envInt("RATE_LIMIT_AUTH_MFA_WINDOW_MINUTES", 15));
  }
}

function ipMax(name: RateLimitClass): number {
  if (name === "general") {
    return envInt(
      "RATE_LIMIT_GENERAL_IP_MAX",
      perUserMax("general") * 50,
    );
  }
  // Login is unauthenticated. Its coarse failed-attempt ceiling is separate
  // from the identifier+IP cap and does not count successful login responses.
  if (name === "authLoginIp") return perUserMax(name);
  if (name === "authEmailIp") return envInt("RATE_LIMIT_AUTH_EMAIL_IP_MAX", 100);
  if (name === "authFlow") return envInt("RATE_LIMIT_AUTH_FLOW_IP_MAX", perUserMax(name) * 50);
  if (name === "authMfa") return envInt("RATE_LIMIT_AUTH_MFA_IP_MAX", perUserMax(name) * 50);
  if (name === "uploadCreate") {
    return envInt(
      "RATE_LIMIT_UPLOAD_SESSION_CREATE_IP_MAX",
      perUserMax(name) * 50,
    );
  }
  if (name === "uploadMutation") {
    return envInt(
      "RATE_LIMIT_UPLOAD_SESSION_MUTATION_IP_MAX",
      perUserMax(name) * 50,
    );
  }
  if (name === "uploadPolling") {
    return envInt(
      "RATE_LIMIT_UPLOAD_SESSION_POLL_IP_MAX",
      perUserMax(name) * 50,
    );
  }
  const explicit = `RATE_LIMIT_${name.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}_IP_MAX`;
  return envInt(explicit, perUserMax(name) * 50);
}

function definition(name: RateLimitClass, scope: RateLimitScope): CounterConfig {
  const messageByName: Partial<Record<RateLimitClass, string>> = {
    chat: "Too many chat requests. Please try again later.",
    export: "Too many export requests. Please try again later.",
    uploadMutation: "Too many upload requests. Please try again later.",
    uploadPolling: "Upload status was checked too often. Please try again shortly.",
    authLoginIp: "Too many login attempts. Please try again later.",
    authLoginIdentifierIp: "Too many login attempts. Please try again later.",
    authEmailIp: "Too many authentication requests. Please try again later.",
    authSignupIdentifierIp: "Too many authentication requests. Please try again later.",
    authResetIdentifierIp: "Too many authentication requests. Please try again later.",
  };
  return {
    name,
    scope,
    windowMs: windowMs(name),
    limit: scope === "ip" ? ipMax(name) : perUserMax(name),
    errorPolicy: scope === "ip" && name === "general" ? "open" : "closed",
    message: messageByName[name],
    skipSuccessfulRequests:
      name === "authLoginIp" || name === "authLoginIdentifierIp",
    ...(scope === "identifier-ip" && name === "authLoginIdentifierIp"
      ? { identifierAction: "login" as const }
      : {}),
    ...(scope === "identifier-ip" && name === "authSignupIdentifierIp"
      ? { identifierAction: "signup" as const }
      : {}),
    ...(scope === "identifier-ip" && name === "authResetIdentifierIp"
      ? { identifierAction: "password-reset" as const }
      : {}),
  };
}

export function rateLimitStoreErrorPolicy(
  name: RateLimitClass,
  scope: RateLimitScope,
): StoreErrorPolicy {
  return definition(name, scope).errorPolicy;
}

function clientIp(req: Request): string {
  return ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? "unknown");
}

function normalizedIdentifier(req: Request): string {
  const email = req.body?.email;
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function keyFor(config: CounterConfig, req: Request, res: Response): string {
  if (config.scope === "ip") return `ip:${clientIp(req)}`;
  if (config.scope === "user") {
    const userId = res.locals.userId;
    return `user:${digest(typeof userId === "string" ? userId : "missing-user")}`;
  }
  const identifier = normalizedIdentifier(req);
  const action = config.identifierAction ?? config.name;
  return `identifier-ip:${digest(`${action}\0${clientIp(req)}\0${identifier}`)}`;
}

function storeFor(name: RateLimitClass, scope: RateLimitScope): Store {
  const namespace = `${name}:${scope}`;
  if (usesSharedRateLimitStore()) {
    const client = getRedisRateLimitConnection() as unknown as RedisRateLimitClient;
    const limiterName = namespace;
    return new ResilientRateLimitStore({
      redis: new RedisRateLimitStore(client, namespace),
      memory: new BoundedMemoryRateLimitStore({ namespace }),
      breaker: sharedRedisRateLimitCircuitBreaker,
      limiterName,
      onDegraded: ({ limiter, reason, mode }) => logStoreDegraded(limiter, reason, mode),
    });
  }
  return new BoundedMemoryRateLimitStore({ namespace });
}

const sharedRedisRateLimitCircuitBreaker = new RedisRateLimitCircuitBreaker({
  failureThreshold: envInt("RATE_LIMIT_REDIS_FAILURE_THRESHOLD", 3),
  cooldownMs: envInt("RATE_LIMIT_REDIS_COOLDOWN_MS", 30_000),
});

const limiterCache = new Map<string, RateLimitRequestHandler>();

function limiterFor(name: RateLimitClass, scope: RateLimitScope): RateLimitRequestHandler {
  const config = definition(name, scope);
  // The runtime config is immutable in production, but route tests and local
  // multi-app harnesses may construct independent apps with different caps in
  // one process. Do not let the first instance's policy bleed into the next.
  const cacheKey = [
    name,
    scope,
    config.windowMs,
    config.limit,
    config.errorPolicy,
    config.skipSuccessfulRequests === true ? "skip-success" : "count-all",
  ].join(":");
  const cached = limiterCache.get(cacheKey);
  if (cached) return cached;
  const limiter = rateLimit({
    windowMs: config.windowMs,
    limit: config.limit,
    keyGenerator: (req, res) => keyFor(config, req, res),
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.method === "OPTIONS",
    skipSuccessfulRequests: config.skipSuccessfulRequests,
    passOnStoreError: config.errorPolicy === "open",
    store: storeFor(name, scope),
    logger: {
      error: () => logStoreDegraded(config.name, "open limiter allowed a request", "memory"),
      warn: (_error, message) => {
        if (message) console.warn("[rate-limit] configuration warning", message);
      },
    },
    message: {
      code: "rate_limit_exceeded",
      detail: config.message ?? "Too many requests. Please try again later.",
    },
  });
  limiterCache.set(cacheKey, limiter);
  return limiter;
}

const middlewareClasses = new WeakMap<RequestHandler, RateLimitClass>();

/** An IP-only, coarse admission/backstop counter. */
export function ipRateLimiter(name: RateLimitClass): RequestHandler {
  return limiterFor(name, "ip");
}

/** An unauthenticated identifier bucket scoped to the source IP and action. */
export function identifierIpRateLimiter(name: RateLimitClass): RequestHandler {
  return limiterFor(name, "identifier-ip");
}

/** A user-keyed counter. Attach after requireAuth or include in requireAuthWithBody. */
export function authenticatedRateLimit(name: RateLimitClass): RequestHandler {
  const limiter = limiterFor(name, "user");
  const middleware: RequestHandler = (req, res, next) => {
    if (typeof res.locals.userId !== "string" || !res.locals.userId) {
      res.status(401).json({ detail: "Invalid or expired session" });
      return;
    }
    limiter(req, res, next);
  };
  middlewareClasses.set(middleware, name);
  return middleware;
}

export function rateLimitClassOf(middleware: RequestHandler): RateLimitClass | undefined {
  return middlewareClasses.get(middleware);
}

/** Body-heavy authenticated JSON requests are parsed only after auth. */
export function authenticatedBodyLimit(
  method: string,
  path: string,
): "256kb" | "2mb" | null {
  const pathname = path.split("?", 1)[0].replace(/\/$/, "") || "/";
  if (pathname === "/upload-sessions" || pathname.startsWith("/upload-sessions/")) {
    return "256kb";
  }
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase())) {
    if (
      pathname === "/chat" ||
      pathname === "/chat/create" ||
      /^\/chat\/[^/]+\/generate-title$/.test(pathname) ||
      pathname === "/word-chat" ||
      pathname === "/word-chat/tool-result" ||
      /^\/projects\/[^/]+\/chat$/.test(pathname) ||
      /^\/tabular-review\/[^/]+\/(chat|generate)$/.test(pathname)
    ) {
      return "2mb";
    }
    if (/^\/workflow-addons\/[^/]+\/import$/.test(pathname)) return "256kb";
  }
  return null;
}

export type RouteRatePolicy = {
  family: string;
  requiresAuthentication: boolean;
  class?: RateLimitClass;
  bodyLimit?: "256kb" | "2mb";
};

/** Shared route classification used by middleware and the route-coverage guard. */
export function routeRatePolicy(method: string, path: string): RouteRatePolicy | null {
  const pathname = path.split("?", 1)[0].replace(/\/$/, "") || "/";
  const verb = method.toUpperCase();
  const bodyLimit = ["POST", "PUT", "PATCH"].includes(verb)
    ? authenticatedBodyLimit(verb, pathname) ?? undefined
    : undefined;
  if (pathname === "/upload-sessions" || pathname.startsWith("/upload-sessions/")) {
    return {
      family: "upload",
      requiresAuthentication: true,
      class: verb === "GET" ? "uploadPolling" : "uploadMutation",
      bodyLimit,
    };
  }
  if (
    verb === "POST" &&
    (pathname === "/chat" ||
      pathname === "/word-chat" ||
      /^\/projects\/[^/]+\/chat$/.test(pathname) ||
      /^\/tabular-review\/[^/]+\/(chat|generate|regenerate-cell)$/.test(pathname) ||
      pathname === "/tabular-review/prompt")
  ) {
    return { family: "llm-chat", requiresAuthentication: true, class: "chat", bodyLimit };
  }
  if (verb === "POST" && pathname === "/word-chat/tool-result") {
    return { family: "tool-result", requiresAuthentication: true, class: "toolResult", bodyLimit };
  }
  if (verb === "POST" && (pathname === "/chat/create" || /^\/chat\/[^/]+\/generate-title$/.test(pathname))) {
    return { family: "chat-create", requiresAuthentication: true, class: "chatCreate", bodyLimit };
  }
  if (pathname.startsWith("/auth/mfa/") && ["POST", "DELETE"].includes(verb)) {
    return { family: "mfa", requiresAuthentication: true, class: "authMfa" };
  }
  if (
    (verb === "POST" && /^\/(user|users)\/exports$/.test(pathname)) ||
    (verb === "GET" &&
      (/^\/(user|users)\/(export|chats\/export|tabular-reviews\/export)$/.test(pathname) ||
        /^\/projects\/[^/]+\/export$/.test(pathname) ||
        pathname === "/audit/export"))
  ) {
    return { family: "export", requiresAuthentication: true, class: "export" };
  }
  if (verb === "POST" && /^\/workflow-addons\/[^/]+\/import$/.test(pathname)) {
    return { family: "workflow-import", requiresAuthentication: true, class: "workflowImport", bodyLimit };
  }
  if (pathname.startsWith("/workflow-addons/")) {
    return { family: "workflow-addons", requiresAuthentication: true, class: "general" };
  }
  if (verb === "DELETE" && /^\/(user|users)\/(account|chats|projects|tabular-reviews|memories)$/.test(pathname)) {
    return { family: "data-delete", requiresAuthentication: true, class: "dataDelete" };
  }
  if (pathname.startsWith("/tabular-review")) {
    return { family: "tabular", requiresAuthentication: true, class: "general", bodyLimit };
  }
  if (pathname.startsWith("/chat") || pathname.startsWith("/word-chat")) {
    return { family: "chat", requiresAuthentication: true, class: "general", bodyLimit };
  }
  if (pathname.endsWith("/oauth/callback")) return null;
  if (
    pathname.includes("/memory") ||
    pathname.includes("mcp-connectors") ||
    pathname.includes("google-actions") ||
    pathname.includes("/integrations/") ||
    pathname.includes("/api-keys") ||
    pathname.startsWith("/quick-actions") ||
    pathname.startsWith("/workflows")
  ) {
    return { family: "external-tools-memory", requiresAuthentication: true, class: "general", bodyLimit };
  }
  return null;
}

export const rateLimitStoreErrorHandler = (
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (!sendRateLimitStoreUnavailable(error, res)) {
    next(error);
  }
};

export function sendRateLimitStoreUnavailable(
  error: unknown,
  res: Response,
): boolean {
  if (!(error instanceof RateLimitStoreUnavailableError)) return false;
  logStoreDegraded(error.limiterName, "bounded memory key capacity exhausted", "memory");
  res.setHeader("Retry-After", "30");
  const requestId = typeof res.locals.requestId === "string" ? res.locals.requestId : undefined;
  res.status(503).json({
    code: "rate_limit_unavailable",
    detail: "Request admission is temporarily unavailable. Please retry shortly.",
    ...(requestId ? { request_id: requestId } : {}),
  });
  return true;
}
