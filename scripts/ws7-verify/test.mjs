import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { parseInvocation, blockLoopbackTarget, httpsTarget, resolveTargetSafety } from "./common.mjs";
import { classifyTlsAndRedirect, probeTlsAndRedirect } from "./tls-and-redirect.mjs";
import { apiHealthUrl, classifySecurityHeaders, probeSecurityHeadersAndCors } from "./security-headers-and-cors.mjs";
import { classifyForwardedIpEvidence, probeForwardedIpTrust } from "./forwarded-ip-trust.mjs";
import { classifyReachability, parseHostPort, probePort } from "./direct-backend-reachability.mjs";
import { anonymousAccessResult, probePublicBucket } from "./public-bucket.mjs";
import { MANUAL_ITEMS, formatManualChecklist } from "./manual-checklist.mjs";

test("argument parsing requires a target and both explicit live-probe flags", () => {
  assert.match(parseInvocation([]).error, /explicit target/);
  assert.match(parseInvocation(["https://app.example.test", "--run"]).error, /both --run/);
  assert.match(parseInvocation(["https://app.example.test", "--i-own-this-target"]).error, /both --run/);
  assert.equal(parseInvocation(["https://app.example.test"]).run, false);
  assert.equal(parseInvocation(["https://app.example.test", "--run", "--i-own-this-target"]).error, "");
  assert.match(parseInvocation(["https://app.example.test", "--nope"]).error, /unsupported/);
});

test("HTTPS target validation and loopback refusal cover local address forms", async () => {
  assert.equal(httpsTarget("app.example.test").protocol, "https:");
  assert.throws(() => httpsTarget("http://app.example.test"), /HTTPS/);
  assert.match(blockLoopbackTarget("127.0.0.1"), /loopback/);
  assert.match(blockLoopbackTarget("localhost"), /loopback/);
  assert.equal(blockLoopbackTarget("app.example.test"), "");
  assert.equal((await resolveTargetSafety("127.0.0.1", async () => [])).status, "FAIL");
  assert.equal((await resolveTargetSafety("app.example.test", async () => [{ address: "127.0.0.2" }])).status, "FAIL");
  assert.equal((await resolveTargetSafety("app.example.test", async () => [{ address: "203.0.113.20" }])).status, "PASS");
});

test("TLS and redirect classification reports each proof independently", async () => {
  const evidence = {
    httpUrl: new URL("http://app.example.test/"),
    httpsUrl: new URL("https://app.example.test/"),
    http: { status: 308, location: "https://app.example.test/login" },
    https: {
      status: 200,
      headers: { "strict-transport-security": "max-age=31536000; includeSubDomains" },
    },
    certificate: {
      validFrom: "Jan 01 00:00:00 2026 GMT",
      validTo: "Jan 01 00:00:00 2027 GMT",
      identityError: false,
      authorizationError: "",
    },
    protocol: "TLSv1.3",
    weakTls10: "not-supported",
    weakTls11: "not-supported",
  };
  assert.equal(classifyTlsAndRedirect(evidence, Date.parse("2026-10-01T00:00:00Z")).every((item) => item.status === "PASS"), true);
  const unsafe = classifyTlsAndRedirect({ ...evidence, weakTls10: "supported", protocol: "TLSv1.1" }, Date.parse("2026-10-01T00:00:00Z"));
  assert.equal(unsafe.some((item) => item.status === "FAIL"), true);
  const uncertain = classifyTlsAndRedirect({ ...evidence, weakTls11: "unknown" }, Date.parse("2026-10-01T00:00:00Z"));
  assert.equal(uncertain.some((item) => item.status === "MANUAL"), true);
  const calls = [];
  const probed = await probeTlsAndRedirect({
    target: "https://app.example.test",
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url), init });
      return url.protocol === "http:"
        ? { status: 308, headers: { location: "https://app.example.test/" }, body: { cancel: async () => {} } }
        : { status: 200, headers: { "strict-transport-security": "max-age=31536000" }, body: { cancel: async () => {} } };
    },
    tlsProbe: async () => ({ protocol: "TLSv1.3", certificate: {
      validFrom: "Jan 01 00:00:00 2026 GMT", validTo: "Jan 01 00:00:00 2027 GMT",
      identityError: false, authorizationError: "",
    } }),
    weakProbe: async () => "not-supported",
  });
  assert.equal(calls.length, 2);
  assert.equal(calls.every(({ init }) => init.method === "HEAD"), true);
  assert.equal(probed.every((item) => item.status === "PASS"), true);
});

test("header and CORS classification requires the edge baseline and rejects hostile origin reflection", async () => {
  const headers = {
    "strict-transport-security": "max-age=31536000",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
  };
  const pass = classifySecurityHeaders({
    frontendHeaders: headers,
    apiHeaders: { ...headers, "x-frame-options": "DENY" },
    preflight: { status: 204, headers: {} },
  });
  assert.equal(pass.every((item) => item.status === "PASS"), true);
  assert.equal(apiHealthUrl("https://app.example.test/api").pathname, "/api/health");
  const hostile = classifySecurityHeaders({
    frontendHeaders: headers,
    apiHeaders: headers,
    preflight: {
      status: 204,
      headers: { "access-control-allow-origin": "https://ws7-hostile-origin.invalid" },
    },
  });
  assert.equal(hostile.some((item) => item.status === "FAIL" && /hostile/.test(item.message)), true);
  const wildcardCredentials = classifySecurityHeaders({
    frontendHeaders: headers,
    apiHeaders: headers,
    preflight: {
      status: 204,
      headers: { "access-control-allow-origin": "*", "access-control-allow-credentials": "true" },
    },
  });
  assert.equal(wildcardCredentials.some((item) => item.status === "FAIL"), true);
  const calls = [];
  const probed = await probeSecurityHeadersAndCors({
    frontendTarget: "https://app.example.test",
    apiTarget: "https://app.example.test/api",
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url), init });
      const responseHeaders = init.method === "OPTIONS" ? {} : headers;
      return { status: init.method === "OPTIONS" ? 204 : 200, headers: responseHeaders, body: { cancel: async () => {} } };
    },
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[2].init.headers.Origin, "https://ws7-hostile-origin.invalid");
  assert.equal(probed.every((item) => item.status === "PASS"), true);
});

test("forwarded-IP classification distinguishes one shared counter from rotated buckets", async () => {
  assert.equal(classifyForwardedIpEvidence([
    { status: 200, remaining: "299" },
    { status: 200, remaining: "298" },
    { status: 200, remaining: "297" },
    { status: 200, remaining: "296" },
  ])[0].status, "PASS");
  assert.equal(classifyForwardedIpEvidence([
    { status: 200, remaining: "299" },
    { status: 200, remaining: "299" },
    { status: 200, remaining: "298" },
    { status: 200, remaining: "298" },
  ])[0].status, "FAIL");
  assert.equal(classifyForwardedIpEvidence([
    { status: 200, remaining: "299" },
    { status: 200, remaining: "297" },
    { status: 200, remaining: "296" },
    { status: 200, remaining: "295" },
  ])[0].status, "MANUAL");
  const sent = [];
  const probed = await probeForwardedIpTrust({
    target: "https://app.example.test",
    pause: async () => {},
    fetchImpl: async (_url, init) => {
      sent.push(init.headers);
      return {
        status: 200,
        headers: { "ratelimit-remaining": String(299 - sent.length) },
        body: { cancel: async () => {} },
      };
    },
  });
  assert.equal(sent.length, 4);
  assert.notEqual(sent[0]["X-Forwarded-For"], sent[1]["X-Forwarded-For"]);
  assert.equal(probed[0].status, "PASS");
});

test("backend reachability requires a literal host and explicit port and classifies safely", async () => {
  assert.deepEqual(parseHostPort("backend.example.test:3001"), { host: "backend.example.test", port: 3001 });
  assert.deepEqual(parseHostPort("[2001:db8::1]:3001"), { host: "2001:db8::1", port: 3001 });
  assert.throws(() => parseHostPort("backend.example.test"));
  assert.equal(classifyReachability("open").status, "FAIL");
  assert.equal(classifyReachability("refused").status, "PASS");
  assert.equal(classifyReachability("unknown").status, "MANUAL");
  class FakeSocket extends EventEmitter {
    setTimeout() {}
    destroy() {}
  }
  const reachable = await probePort({
    host: "backend.example.test", port: 3001,
    connectImpl: () => {
      const socket = new FakeSocket();
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    },
  });
  assert.equal(reachable, "open");
});

test("anonymous bucket results and fake requests never use credentials or mutate data", async () => {
  assert.equal(anonymousAccessResult("listing", 403).status, "PASS");
  assert.equal(anonymousAccessResult("read", 200).status, "FAIL");
  assert.equal(anonymousAccessResult("read", 404).status, "MANUAL");
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url: new URL(url), init });
    return { status: 403, headers: {}, body: { cancel: async () => {} } };
  };
  const results = await probePublicBucket({
    bucketTarget: "https://storage.example.test/legal",
    objectTarget: "https://storage.example.test/legal/canary.pdf",
    fetchImpl: fakeFetch,
  });
  assert.deepEqual(results.map((item) => item.status), ["PASS", "PASS"]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.searchParams.get("max-keys"), "1");
  assert.equal(calls.every(({ init }) => init.method === "GET" && init.redirect === "manual"), true);
  assert.equal(calls.some(({ init }) => init.headers), false);
});

test("manual dashboard checklist is tied to every facts-report item and never needs a host", () => {
  assert.equal(formatManualChecklist("")[0].startsWith("FAIL:"), true);
  const lines = formatManualChecklist("vaultr-prod");
  assert.equal(lines.length, MANUAL_ITEMS.length + 1);
  assert.equal(MANUAL_ITEMS.length, 35);
  for (const [id] of MANUAL_ITEMS) assert.equal(lines.some((line) => line.includes(`${id}:`)), true);
});
