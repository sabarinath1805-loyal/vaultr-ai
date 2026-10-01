import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { aiSdkFetch } from "../lib/llm/aiSdk";

const require = createRequire(__filename);
const guard = require("../../../scripts/test-network-guard.cjs") as {
  clearBlockedAttempts: () => void;
  isLoopbackHost: (host: string) => boolean;
  isFetchGuarded: (targetGlobal?: typeof globalThis) => boolean;
  state: () => { blocked: Array<{ host: string; api: string }> };
};

const publicHost = "provider-egress.test.invalid";

afterEach(() => guard.clearBlockedAttempts());

describe("test network guard", () => {
  it("wraps this isolated test file's global fetch", () => {
    expect(guard.isFetchGuarded(globalThis)).toBe(true);
  });

  it("permits loopback IPv4, IPv6, localhost names, and Unix sockets", async () => {
    expect(guard.isLoopbackHost("127.0.0.1")).toBe(true);
    expect(guard.isLoopbackHost("127.255.255.254")).toBe(true);
    expect(guard.isLoopbackHost("::1")).toBe(true);
    expect(guard.isLoopbackHost("[0:0:0:0:0:0:0:1]")).toBe(true);
    expect(guard.isLoopbackHost("localhost.")).toBe(true);
    expect(guard.isLoopbackHost("test.localhost")).toBe(true);

    const server = http.createServer((_request, response) => response.end("loopback"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected an IP listener");
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/`);
      expect(await response.text()).toBe("loopback");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }

    const directory = await mkdtemp(path.join(os.tmpdir(), "test-network-guard-"));
    const socketPath = path.join(directory, "local.sock");
    const socketServer = net.createServer((socket) => socket.end("unix"));
    await new Promise<void>((resolve, reject) => socketServer.listen(socketPath, (error?: Error) => error ? reject(error) : resolve()));
    try {
      const socket = net.connect(socketPath);
      const received = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        socket.on("error", reject);
      });
      expect(received).toBe("unix");
    } finally {
      await new Promise<void>((resolve) => socketServer.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("blocks public destinations through fetch, HTTP, HTTPS, net, and TLS before connecting", async () => {
    const checks: Array<[string, string, () => unknown]> = [
      ["globalThis.fetch", "globalThis.fetch", () => fetch(`https://${publicHost}/path`)],
      ["node:http.request", "node:http.request", () => http.request(`http://${publicHost}/path`)],
      ["node:http.request options", "node:http.request", () => http.request({ hostname: publicHost, port: 80 })],
      ["node:http.get", "node:http.get", () => http.get(`http://${publicHost}/path`)],
      ["node:https.request", "node:https.request", () => https.request(`https://${publicHost}/path`)],
      ["node:https.request options", "node:https.request", () => https.request({ hostname: publicHost, port: 443 })],
      ["node:https.get", "node:https.get", () => https.get(`https://${publicHost}/path`)],
      ["node:net.connect", "node:net.connect", () => net.connect(443, publicHost)],
      ["node:net.createConnection", "node:net.createConnection", () => net.createConnection({ host: publicHost, port: 443 })],
      ["node:tls.connect", "node:tls.connect", () => tls.connect(443, { host: publicHost })],
    ];
    for (const [label, api, call] of checks) {
      expect(call, label).toThrow(publicHost);
      expect(guard.state().blocked.at(-1)).toMatchObject({ host: publicHost, api });
    }
  });

  it("blocks callback and promise DNS lookup APIs for public names", async () => {
    const callback = () => undefined;
    const syncChecks: Array<[string, string, () => unknown]> = [
      ["lookup", publicHost, () => dns.lookup(publicHost, callback)],
      ["lookupService", publicHost, () => dns.lookupService(publicHost, 443, callback)],
      ["resolve", publicHost, () => dns.resolve(publicHost, callback)],
      ["resolve4", publicHost, () => dns.resolve4(publicHost, callback)],
      ["resolve6", publicHost, () => dns.resolve6(publicHost, callback)],
      ["resolveAny", publicHost, () => dns.resolveAny(publicHost, callback)],
      ["resolveCaa", publicHost, () => dns.resolveCaa(publicHost, callback)],
      ["resolveCname", publicHost, () => dns.resolveCname(publicHost, callback)],
      ["resolveMx", publicHost, () => dns.resolveMx(publicHost, callback)],
      ["resolveNaptr", publicHost, () => dns.resolveNaptr(publicHost, callback)],
      ["resolveNs", publicHost, () => dns.resolveNs(publicHost, callback)],
      ["resolvePtr", publicHost, () => dns.resolvePtr(publicHost, callback)],
      ["resolveSoa", publicHost, () => dns.resolveSoa(publicHost, callback)],
      ["resolveSrv", publicHost, () => dns.resolveSrv(publicHost, callback)],
      ["resolveTxt", publicHost, () => dns.resolveTxt(publicHost, callback)],
      ["reverse", "203.0.113.44", () => dns.reverse("203.0.113.44", callback)],
    ];
    for (const [name, host, call] of syncChecks) {
      expect(call, `node:dns.${name}`).toThrow(host);
    }

    expect(() => dnsPromises.lookup(publicHost)).toThrow(publicHost);
    expect(() => dnsPromises.resolve4(publicHost)).toThrow(publicHost);
    expect(() => dnsPromises.resolve6(publicHost)).toThrow(publicHost);
    const resolver = new dnsPromises.Resolver();
    for (const name of ["resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname", "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt", "reverse"] as const) {
      const method = resolver[name] as (host: string) => unknown;
      const host = name === "reverse" ? "203.0.113.44" : publicHost;
      expect(() => method.call(resolver, host), `Resolver.${name}`).toThrow(host);
    }
    expect(guard.state().blocked.length).toBeGreaterThanOrEqual(syncChecks.length + 3 + 14);
  });

  it("does not permit an unreviewed per-file network-guard opt-out marker", async () => {
    const fs = await import("node:fs/promises");
    const pathModule = await import("node:path");
    const root = pathModule.resolve(__dirname, "../../../");
    const roots = ["backend", "frontend", "word-addin", "e2e", "scripts"];
    const files: string[] = [];
    const collect = async (directory: string) => {
      let entries;
      try { entries = await fs.readdir(directory, { withFileTypes: true }); }
      catch { return; }
      for (const entry of entries) {
        if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "dist") continue;
        const full = pathModule.join(directory, entry.name);
        if (entry.isDirectory()) await collect(full);
        else if (/\.(?:[cm]?[jt]sx?)$/.test(entry.name)) files.push(full);
      }
    };
    for (const relative of roots) await collect(pathModule.join(root, relative));
    const approvedReasons = new Map<string, string>();
    const marker = /^\s*\/\/\s*TEST NETWORK ALLOWLIST:\s*(.+)$/gim;
    const unauthorized = [] as string[];
    for (const file of files) {
      const text = await fs.readFile(file, "utf8");
      for (const match of text.matchAll(marker)) {
        const reason = match[1]?.trim() ?? "";
        const relative = pathModule.relative(root, file);
        if (!reason || approvedReasons.get(relative) !== reason) unauthorized.push(relative);
      }
    }
    expect(unauthorized).toEqual([]);
    expect(approvedReasons.size).toBe(0);
  });

  it("blocks the original default Google SDK request before a local proxy receives anything", async () => {
    const received: string[] = [];
    const proxy = http.createServer((request, response) => {
      received.push(request.url ?? "");
      response.writeHead(502).end();
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("Expected a proxy listener");
    const previousHttpProxy = process.env.HTTPS_PROXY;
    const previousLowerHttpProxy = process.env.https_proxy;
    process.env.HTTPS_PROXY = `http://127.0.0.1:${address.port}`;
    process.env.https_proxy = process.env.HTTPS_PROXY;
    try {
      const [{ generateText }, { createGoogleGenerativeAI }] = await Promise.all([
        import("ai"),
        import("@ai-sdk/google"),
      ]);
      const google = createGoogleGenerativeAI({ apiKey: "synthetic-test-key" });
      await expect(
        generateText({
          model: google("gemini-3-flash-preview"),
          prompt: "Synthetic network-guard test prompt.",
          maxOutputTokens: 1,
          maxRetries: 0,
        }),
      ).rejects.toThrow("generativelanguage.googleapis.com");
      // WS6's guarded provider transport uses the package-level Undici fetch,
      // which bypasses a global fetch stub. Exercise that exact path too.
      await expect(
        aiSdkFetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:streamGenerateContent"),
      ).rejects.toThrow("generativelanguage.googleapis.com");
      expect(received).toEqual([]);
      expect(guard.state().blocked.at(-1)).toMatchObject({ host: "generativelanguage.googleapis.com" });
    } finally {
      if (previousHttpProxy === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = previousHttpProxy;
      if (previousLowerHttpProxy === undefined) delete process.env.https_proxy;
      else process.env.https_proxy = previousLowerHttpProxy;
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });
});
