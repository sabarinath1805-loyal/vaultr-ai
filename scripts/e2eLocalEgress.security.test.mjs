import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { once } from "node:events";
import test from "node:test";
import "./test-network-guard.cjs";
const require = createRequire(import.meta.url);
const { startLocalEgressGuard } = require("./e2e-local-egress-guard.cjs");

function requestThroughProxy(proxyUrl, targetUrl) {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: proxy.hostname,
        port: Number(proxy.port),
        method: "GET",
        path: targetUrl,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
      },
    );
    request.on("error", reject);
    request.end();
  });
}

test("browser proxy forwards loopback requests and rejects public targets before resolving them", async () => {
  const upstream = http.createServer((_request, response) => response.end("local-control"));
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamPort = upstream.address().port;
  const guard = await startLocalEgressGuard({ host: "127.0.0.1", port: 0 });

  try {
    const control = await requestThroughProxy(
      guard.serverUrl,
      `http://127.0.0.1:${upstreamPort}/control`,
    );
    const attack = await requestThroughProxy(
      guard.serverUrl,
      "https://provider-egress.invalid/should-not-resolve",
    );
    assert.deepEqual(control, { status: 200, body: "local-control" });
    assert.equal(attack.status, 403);
    assert.match(attack.body, /local-only E2E network guard/);
    assert.deepEqual(guard.getSummary(), {
      allowedLoopbackRequests: 1,
      allowedLoopbackTargets: [{ target: `127.0.0.1:${upstreamPort}`, count: 1 }],
      blockedExternalRequests: 1,
      blockedExternalTargets: [{ target: "provider-egress.invalid:443", count: 1 }],
    });
  } finally {
    await guard.close();
    await new Promise((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
