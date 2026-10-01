import { createHash, randomUUID } from "node:crypto";
import type { Response } from "express";
import { getRedisRateLimitConnection } from "./queue/connection";
import { usesSharedRateLimitStore } from "./rateLimit";
import { streamCapacityConfiguration } from "./runtimeConfig";
import type { Db } from "./supabase";

export type StreamCapacityLimits = {
  maxPerUser: number;
  maxPerOrg: number;
};

type CapacityRedisClient = {
  eval: (script: string, numberOfKeys: number, ...args: Array<string | number>) => Promise<unknown>;
};

const redisReserveScript = `
local now = tonumber(ARGV[2])
local user_limit = tonumber(ARGV[4])
local org_limit = tonumber(ARGV[5])
local has_org = ARGV[6] == '1'
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if has_org then redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now) end
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then return 1 end
if redis.call('ZCARD', KEYS[1]) >= user_limit then return 0 end
if has_org and redis.call('ZCARD', KEYS[2]) >= org_limit then return 0 end
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[1])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]) - now + 60000)
if has_org then
  redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
  redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[3]) - now + 60000)
end
return 1
`;

const redisReleaseScript = `
redis.call('ZREM', KEYS[1], ARGV[1])
if redis.call('ZCARD', KEYS[1]) == 0 then redis.call('DEL', KEYS[1]) end
if ARGV[2] == '1' then
  redis.call('ZREM', KEYS[2], ARGV[1])
  if redis.call('ZCARD', KEYS[2]) == 0 then redis.call('DEL', KEYS[2]) end
end
return 1
`;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class BoundedMemoryStreamCapacityStore {
  private readonly leases: Map<
    string,
    { user: string; org: string | null; expiresAt: number }
  >;

  constructor(
    private readonly options: {
      maxKeys: number;
      now?: () => number;
      state?: Map<string, { user: string; org: string | null; expiresAt: number }>;
    },
  ) {
    this.leases = options.state ?? new Map();
  }

  tryAcquire(
    leaseId: string,
    userId: string,
    orgId: string | null,
    limits: StreamCapacityLimits,
    ttlMs: number,
  ): boolean {
    const now = (this.options.now ?? Date.now)();
    this.purgeExpired(now);
    const user = digest(userId);
    const org = orgId ? digest(orgId) : null;
    const existing = this.leases.get(leaseId);
    if (existing) return existing.user === user && existing.org === org;
    if (this.leases.size >= Math.max(1, this.options.maxKeys)) return false;

    let userCount = 0;
    let orgCount = 0;
    for (const lease of this.leases.values()) {
      if (lease.user === user) userCount++;
      if (org && lease.org === org) orgCount++;
    }
    if (userCount >= limits.maxPerUser || (org && orgCount >= limits.maxPerOrg)) {
      return false;
    }
    this.leases.set(leaseId, {
      user,
      org,
      expiresAt: now + Math.max(1, ttlMs),
    });
    return true;
  }

  release(leaseId: string): void {
    this.leases.delete(leaseId);
  }

  size(): number {
    this.purgeExpired((this.options.now ?? Date.now)());
    return this.leases.size;
  }

  private purgeExpired(now: number): void {
    for (const [id, lease] of this.leases) {
      if (lease.expiresAt <= now) this.leases.delete(id);
    }
  }
}

export class RedisStreamCapacityStore {
  constructor(private readonly client: CapacityRedisClient) {}

  async tryAcquire(
    leaseId: string,
    userId: string,
    orgId: string | null,
    limits: StreamCapacityLimits,
    ttlMs: number,
    now = Date.now(),
  ): Promise<boolean> {
    const hasOrg = !!orgId;
    const result = await this.client.eval(
      redisReserveScript,
      2,
      `vaultr:stream-capacity:v1:user:${digest(userId)}`,
      `vaultr:stream-capacity:v1:org:${hasOrg ? digest(orgId as string) : "none"}`,
      leaseId,
      now,
      now + Math.max(1, ttlMs),
      limits.maxPerUser,
      limits.maxPerOrg,
      hasOrg ? 1 : 0,
    );
    return Number(result) === 1;
  }

  async release(leaseId: string, userId: string, orgId: string | null): Promise<void> {
    const hasOrg = !!orgId;
    await this.client.eval(
      redisReleaseScript,
      2,
      `vaultr:stream-capacity:v1:user:${digest(userId)}`,
      `vaultr:stream-capacity:v1:org:${hasOrg ? digest(orgId as string) : "none"}`,
      leaseId,
      hasOrg ? 1 : 0,
    );
  }
}

export type StreamCapacityLease = { release: () => void };

const sharedMemoryLeases = new Map<
  string,
  { user: string; org: string | null; expiresAt: number }
>();
const memoryStore = (maxKeys: number) =>
  new BoundedMemoryStreamCapacityStore({
    maxKeys,
    state: sharedMemoryLeases,
  });
let lastStoreWarningAt = 0;

function warnStoreDegraded(error: unknown): void {
  const now = Date.now();
  if (now - lastStoreWarningAt < 60_000) return;
  lastStoreWarningAt = now;
  console.warn("[stream-capacity] shared store degraded; using process-local limits", {
    reason: error instanceof Error ? error.name : "store_error",
  });
}

export async function reserveStreamCapacity(
  userId: string,
  orgId: string | null = null,
): Promise<StreamCapacityLease | null> {
  const config = streamCapacityConfiguration();
  const fallback = memoryStore(config.memoryMaxKeys);
  const leaseId = randomUUID();
  const ttlMs = config.maxDurationMs + 60_000;
  let release: () => void;

  if (usesSharedRateLimitStore()) {
    try {
      const store = new RedisStreamCapacityStore(
        getRedisRateLimitConnection() as unknown as CapacityRedisClient,
      );
      const accepted = await store.tryAcquire(
        leaseId,
        userId,
        orgId,
        config,
        ttlMs,
      );
      if (!accepted) return null;
      let released = false;
      release = () => {
        if (released) return;
        released = true;
        void store.release(leaseId, userId, orgId).catch(warnStoreDegraded);
      };
    } catch (error) {
      warnStoreDegraded(error);
      const accepted = fallback.tryAcquire(
        leaseId,
        userId,
        orgId,
        config,
        ttlMs,
      );
      if (!accepted) return null;
      release = () => fallback.release(leaseId);
    }
  } else {
    const accepted = fallback.tryAcquire(
      leaseId,
      userId,
      orgId,
      config,
      ttlMs,
    );
    if (!accepted) return null;
    release = () => fallback.release(leaseId);
  }

  return { release };
}

/** Reserve before opening an SSE response; release on either terminal event. */
export async function admitAssistantStream(
  res: Pick<
    Response,
    "once" | "setHeader" | "status" | "json" | "destroyed" | "writableEnded"
  >,
  userId: string,
  orgId: string | null = null,
): Promise<boolean> {
  if (res.destroyed || res.writableEnded) return false;
  let closed = false;
  let lease: StreamCapacityLease | null = null;
  let released = false;
  const release = () => {
    closed = true;
    if (lease && !released) {
      released = true;
      lease.release();
    }
  };
  // Subscribe before the shared-store await. A client can disconnect while
  // Redis is deciding admission; otherwise the lease would have no terminal
  // event listener and would occupy capacity until its expiry.
  res.once("finish", release);
  res.once("close", release);
  lease = await reserveStreamCapacity(userId, orgId);
  if (!lease) {
    if (closed || res.destroyed || res.writableEnded) return false;
    res.setHeader("Retry-After", "10");
    res.status(429).json({
      code: "stream_capacity_exceeded",
      detail: "Too many active streams. Try again shortly.",
    });
    return false;
  }
  if (closed || res.destroyed || res.writableEnded) {
    release();
    return false;
  }
  return true;
}

/** Resolve a project's organization only after the route has authorized its access. */
export async function organizationIdForProject(
  db: Db,
  projectId: string | null,
): Promise<string | null> {
  if (!projectId) return null;
  const { data, error } = await db
    .from("projects")
    .select("org_id")
    .eq("id", projectId)
    .maybeSingle();
  if (error) throw new Error("Unable to resolve stream capacity scope.");
  return typeof data?.org_id === "string" ? data.org_id : null;
}
