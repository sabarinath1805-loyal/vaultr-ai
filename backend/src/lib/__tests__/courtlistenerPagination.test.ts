import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent } from "undici";

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  undiciFetch: vi.fn(),
}));

vi.mock("dns/promises", () => ({ default: { lookup: mocks.lookup } }));
vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return { ...actual, fetch: mocks.undiciFetch };
});

import { getCourtlistenerCaseOpinions } from "../courtlistener";

type Reply = { status?: number; headers?: Record<string, string>; body: unknown };
type ObservedRequest = { url: string; authorization: string | null };
type LogicalRequest = { url: string; authorization: string | null };
type TransportPolicy = { redirect: unknown; guardedDispatcher: boolean };
const nativeFetch = globalThis.fetch;

describe("CourtListener opinion pagination egress", () => {
  let server: Server | undefined;
  let localOrigin = "";
  let replies: Reply[] = [];
  let observed: ObservedRequest[] = [];
  let logicalRequests: LogicalRequest[] = [];
  let transportPolicies: TransportPolicy[] = [];

  beforeEach(() => {
    replies = [];
    observed = [];
    logicalRequests = [];
    transportPolicies = [];
    mocks.lookup.mockReset().mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
    ]);
    mocks.undiciFetch.mockReset();
    mocks.undiciFetch.mockImplementation(async (input, init) => {
      const logicalUrl = new URL(String(input));
      const headers = new Headers(init?.headers);
      logicalRequests.push({
        url: logicalUrl.toString(),
        authorization: headers.get("authorization"),
      });
      transportPolicies.push({
        redirect: init?.redirect,
        guardedDispatcher: init?.dispatcher instanceof Agent,
      });
      // The transport maps logical destinations to this local fake server.
      // The real guardedFetch performs URL, DNS, and redirect checks before
      // reaching this point, so tests never contact a provider or hostile host.
      const { dispatcher: _dispatcher, ...safeInit } = init as RequestInit & {
        dispatcher?: unknown;
      };
      return nativeFetch(
        `${localOrigin}${logicalUrl.pathname}${logicalUrl.search}`,
        safeInit,
      );
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (server?.listening) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
    }
    server = undefined;
    mocks.undiciFetch.mockReset();
    mocks.lookup.mockReset();
  });

  async function startFakeCourtListener(initialReplies: Reply[]) {
    replies = [...initialReplies];
    server = createServer((request, response) => {
      observed.push({
        url: request.url ?? "",
        authorization: request.headers.authorization ?? null,
      });
      const reply = replies.shift() ?? { body: { results: [], next: null } };
      response.writeHead(reply.status ?? 200, {
        "content-type": "application/json",
        ...reply.headers,
      });
      response.end(JSON.stringify(reply.body));
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No local port");
    localOrigin = `http://127.0.0.1:${address.port}`;
  }

  async function expectNextBlocked(next: string) {
    vi.stubEnv("COURTLISTENER_BULK_DATA_ENABLED", "false");
    await startFakeCourtListener([
      { body: { results: [], next } },
      { body: { results: [], next: null } },
    ]);

    await expect(
      getCourtlistenerCaseOpinions({
        clusterId: 123,
        apiToken: "synthetic-courtlistener-token",
      }),
    ).rejects.toThrow(/CourtListener/i);

    expect(logicalRequests).toEqual([
      {
        url: "https://www.courtlistener.com/api/rest/v4/opinions/?cluster=123",
        authorization: "Token synthetic-courtlistener-token",
      },
    ]);
    expect(observed).toEqual([
      {
        url: "/api/rest/v4/opinions/?cluster=123",
        authorization: "Token synthetic-courtlistener-token",
      },
    ]);
    expect(transportPolicies).toEqual([
      { redirect: "manual", guardedDispatcher: true },
    ]);
  }

  it.each([
    ["different host", "https://attacker.example/collect?from=next"],
    ["HTTP downgrade", "http://www.courtlistener.com/api/rest/v4/opinions/?cluster=123"],
    ["localhost", "https://localhost/api/rest/v4/opinions/?cluster=123"],
    ["loopback IPv4", "https://127.0.0.1/api/rest/v4/opinions/?cluster=123"],
    ["private 10/8", "https://10.10.0.5/api/rest/v4/opinions/?cluster=123"],
    ["private 172.16/12", "https://172.16.2.5/api/rest/v4/opinions/?cluster=123"],
    ["private 192.168/16", "https://192.168.1.5/api/rest/v4/opinions/?cluster=123"],
    ["link-local metadata", "https://169.254.169.254/latest/meta-data/"],
    ["IPv6 loopback", "https://[::1]/api/rest/v4/opinions/?cluster=123"],
    ["IPv6 unique local", "https://[fd00::1]/api/rest/v4/opinions/?cluster=123"],
    ["IPv6 link local", "https://[fe80::1]/api/rest/v4/opinions/?cluster=123"],
    ["IPv4-mapped IPv6", "https://[::ffff:127.0.0.1]/api/rest/v4/opinions/?cluster=123"],
    ["file scheme", "file:///etc/passwd"],
    ["gopher scheme", "gopher://127.0.0.1:70/"],
    ["userinfo redirect", "https://api@attacker.example/collect"],
    ["userinfo on allowed host", "https://user:pass@www.courtlistener.com/api/rest/v4/opinions/?cluster=123"],
    ["unusual port", "https://www.courtlistener.com:8443/api/rest/v4/opinions/?cluster=123"],
    ["decimal IPv4", "https://2130706433/api/rest/v4/opinions/?cluster=123"],
    ["short IPv4", "https://127.1/api/rest/v4/opinions/?cluster=123"],
    ["octal IPv4", "https://0177.0.0.1/api/rest/v4/opinions/?cluster=123"],
    ["hex IPv4", "https://0x7f000001/api/rest/v4/opinions/?cluster=123"],
    ["misleading subdomain", "https://www.courtlistener.com.attacker.example/api/rest/v4/opinions/?cluster=123"],
    ["trailing dot hostname", "https://www.courtlistener.com./api/rest/v4/opinions/?cluster=123"],
    ["encoded hostname", "https://www.courtlistener.com%2eattacker.example/api/rest/v4/opinions/?cluster=123"],
    ["wrong API path", "https://www.courtlistener.com/api/rest/v4/search/?cluster=123"],
    ["foreign cluster", "https://www.courtlistener.com/api/rest/v4/opinions/?cluster=999"],
  ])("blocks a %s pagination URL without forwarding credentials", async (_label, next) => {
    await expectNextBlocked(next);
  });

  it("follows normal same-origin pagination and keeps tokens isolated per caller", async () => {
    vi.stubEnv("COURTLISTENER_BULK_DATA_ENABLED", "false");
    await startFakeCourtListener([
      {
        body: {
          results: [{ id: 1, plain_text: "First opinion" }],
          next: "https://www.courtlistener.com/api/rest/v4/opinions/?cluster=123&cursor=page2",
        },
      },
      { body: { results: [{ id: 2, plain_text: "Second opinion" }], next: null } },
      { body: { results: [], next: null } },
    ]);

    const first = await getCourtlistenerCaseOpinions({
      clusterId: 123,
      apiToken: "synthetic-token-user-a",
    });
    if ("error" in first) {
      throw new Error(`Expected opinion data, got: ${first.error}`);
    }
    await getCourtlistenerCaseOpinions({
      clusterId: 456,
      apiToken: "synthetic-token-user-b",
    });

    expect(first.source).toBe("api");
    expect(first.opinions.map((opinion) => opinion.text)).toEqual([
      "First opinion",
      "Second opinion",
    ]);
    expect(logicalRequests.map((request) => request.url)).toEqual([
      "https://www.courtlistener.com/api/rest/v4/opinions/?cluster=123",
      "https://www.courtlistener.com/api/rest/v4/opinions/?cluster=123&cursor=page2",
      "https://www.courtlistener.com/api/rest/v4/opinions/?cluster=456",
    ]);
    expect(logicalRequests.map((request) => request.authorization)).toEqual([
      "Token synthetic-token-user-a",
      "Token synthetic-token-user-a",
      "Token synthetic-token-user-b",
    ]);
    expect(transportPolicies).toEqual(
      Array.from({ length: 3 }, () => ({
        redirect: "manual",
        guardedDispatcher: true,
      })),
    );
  });

  it("revalidates a cross-host redirect and strips the CourtListener token", async () => {
    vi.stubEnv("COURTLISTENER_BULK_DATA_ENABLED", "false");
    await startFakeCourtListener([
      {
        status: 302,
        headers: { location: "https://attacker.example/collect" },
        body: {},
      },
      { body: { results: [], next: null } },
    ]);

    await getCourtlistenerCaseOpinions({
      clusterId: 123,
      apiToken: "synthetic-courtlistener-token",
    });

    expect(logicalRequests).toEqual([
      {
        url: "https://www.courtlistener.com/api/rest/v4/opinions/?cluster=123",
        authorization: "Token synthetic-courtlistener-token",
      },
      { url: "https://attacker.example/collect", authorization: null },
    ]);
    expect(observed).toHaveLength(2);
    expect(observed[1].authorization).toBeNull();
    expect(transportPolicies).toEqual(
      Array.from({ length: 2 }, () => ({
        redirect: "manual",
        guardedDispatcher: true,
      })),
    );
  });

  it.each([
    ["scheme downgrade", "http://attacker.example/collect"],
    ["loopback redirect", "https://127.0.0.1/collect"],
    ["link-local redirect", "https://169.254.169.254/latest/meta-data/"],
  ])("blocks a %s before the redirected request", async (_label, location) => {
    vi.stubEnv("COURTLISTENER_BULK_DATA_ENABLED", "false");
    await startFakeCourtListener([
      { status: 302, headers: { location }, body: {} },
      { body: { results: [], next: null } },
    ]);

    await expect(
      getCourtlistenerCaseOpinions({
        clusterId: 123,
        apiToken: "synthetic-courtlistener-token",
      }),
    ).rejects.toThrow();

    expect(logicalRequests).toHaveLength(1);
    expect(observed).toHaveLength(1);
  });

  it("blocks when the allowlisted CourtListener hostname resolves to a private address", async () => {
    vi.stubEnv("COURTLISTENER_BULK_DATA_ENABLED", "false");
    await startFakeCourtListener([{ body: { results: [], next: null } }]);
    mocks.lookup.mockResolvedValue([
      { address: "127.0.0.1", family: 4 },
    ]);

    await expect(
      getCourtlistenerCaseOpinions({
        clusterId: 123,
        apiToken: "synthetic-courtlistener-token",
      }),
    ).rejects.toThrow(/blocked network address/i);

    expect(logicalRequests).toHaveLength(0);
    expect(observed).toHaveLength(0);
  });
});
