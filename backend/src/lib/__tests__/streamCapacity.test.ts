import { describe, expect, it, vi } from "vitest";
import { admitAssistantStream } from "../streamCapacity";
import {
  BoundedMemoryStreamCapacityStore,
  RedisStreamCapacityStore,
} from "../streamCapacity";

const { evalMock } = vi.hoisted(() => ({ evalMock: vi.fn() }));
vi.mock("../rateLimit", () => ({ usesSharedRateLimitStore: () => true }));
vi.mock("../queue/connection", () => ({
  getRedisRateLimitConnection: () => ({ eval: evalMock }),
}));

const limits = { maxPerUser: 2, maxPerOrg: 3 };

describe("bounded memory stream capacity", () => {
  it("limits each user and organization without starving another user", () => {
    let now = 1_000;
    const store = new BoundedMemoryStreamCapacityStore({
      maxKeys: 20,
      now: () => now,
    });

    expect(store.tryAcquire("s1", "user-a", "org-1", limits, 1_000)).toBe(true);
    expect(store.tryAcquire("s2", "user-a", "org-1", limits, 1_000)).toBe(true);
    expect(store.tryAcquire("s3", "user-a", "org-1", limits, 1_000)).toBe(false);
    expect(store.tryAcquire("s4", "user-b", "org-1", limits, 1_000)).toBe(true);
    expect(store.tryAcquire("s5", "user-c", "org-1", limits, 1_000)).toBe(false);

    store.release("s1");
    expect(store.tryAcquire("s6", "user-a", "org-1", limits, 1_000)).toBe(true);

    now += 1_001;
    expect(store.tryAcquire("s7", "user-c", "org-1", limits, 1_000)).toBe(true);
  });

  it("does not evict active entries when its key bound is full", () => {
    const store = new BoundedMemoryStreamCapacityStore({ maxKeys: 1 });
    expect(store.tryAcquire("s1", "user-a", null, limits, 10_000)).toBe(true);
    expect(store.tryAcquire("s2", "user-b", null, limits, 10_000)).toBe(false);
    expect(store.size()).toBe(1);
    store.release("s1");
    expect(store.tryAcquire("s2", "user-b", null, limits, 10_000)).toBe(true);
  });
});

describe("Redis stream capacity store", () => {
  it("uses bounded hashed keys and one atomic two-scope lease operation", async () => {
    const evalMock = vi.fn().mockResolvedValue(1);
    const store = new RedisStreamCapacityStore({ eval: evalMock });
    await expect(
      store.tryAcquire("lease-id", "synthetic-user", "synthetic-org", limits, 30_000),
    ).resolves.toBe(true);
    const [script, keyCount, userKey, orgKey, ...args] = evalMock.mock.calls[0];
    expect(script).toContain("ZREMRANGEBYSCORE");
    expect(script).toContain("ZCARD");
    expect(keyCount).toBe(2);
    expect(userKey).toMatch(/^vaultr:stream-capacity:v1:user:[a-f0-9]{64}$/);
    expect(orgKey).toMatch(/^vaultr:stream-capacity:v1:org:[a-f0-9]{64}$/);
    expect(JSON.stringify(evalMock.mock.calls[0])).not.toContain("synthetic-user");
    expect(JSON.stringify(evalMock.mock.calls[0])).not.toContain("synthetic-org");
    expect(args).toContain("lease-id");
  });

  it("releases a lease if the client disconnects while Redis admission is pending", async () => {
    let resolveAdmission: ((value: number) => void) | undefined;
    evalMock
      .mockImplementationOnce(
        () => new Promise<number>((resolve) => { resolveAdmission = resolve; }),
      )
      .mockResolvedValueOnce(1);
    const listeners = new Map<string, (() => void)[]>();
    const response = {
      destroyed: false,
      writableEnded: false,
      once: vi.fn((event: string, listener: () => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      }),
      setHeader: vi.fn(),
      status: vi.fn(),
      json: vi.fn(),
    };
    response.status.mockImplementation(() => response);

    const admission = admitAssistantStream(
      response as never,
      "synthetic-user",
      "synthetic-org",
    );
    for (const listener of listeners.get("close") ?? []) listener();
    resolveAdmission?.(1);

    await expect(admission).resolves.toBe(false);
    expect(evalMock).toHaveBeenCalledTimes(2);
    expect(evalMock.mock.calls[1][0]).toContain("ZREM");
    expect(response.json).not.toHaveBeenCalled();
  });

  it("returns a generic retry response when the shared organization cap is full", async () => {
    evalMock.mockResolvedValueOnce(0);
    const response = {
      destroyed: false,
      writableEnded: false,
      once: vi.fn(),
      setHeader: vi.fn(),
      status: vi.fn(),
      json: vi.fn(),
    };
    response.status.mockImplementation(() => response);

    await expect(
      admitAssistantStream(response as never, "synthetic-user", "synthetic-org"),
    ).resolves.toBe(false);
    expect(response.setHeader).toHaveBeenCalledWith("Retry-After", "10");
    expect(response.status).toHaveBeenCalledWith(429);
    expect(JSON.stringify(response.json.mock.calls)).not.toContain("synthetic-user");
    expect(JSON.stringify(response.json.mock.calls)).not.toContain("synthetic-org");
  });
});
