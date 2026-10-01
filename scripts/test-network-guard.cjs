/*
 * Test-process network boundary. This is loaded before each Vitest file and
 * by the Word add-in's Node test runner. Browser tests still enforce their
 * own page-level request policy because browser sockets live in another
 * process.
 */
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const tls = require("node:tls");
const dns = require("node:dns");
const dnsPromises = require("node:dns/promises");
const { syncBuiltinESMExports } = require("node:module");

const STATE_KEY = Symbol.for("vaultr.testNetworkGuard.state");
const WRAPPED = Symbol.for("vaultr.testNetworkGuard.wrapped");

function state(targetGlobal = globalThis) {
  if (!targetGlobal[STATE_KEY]) {
    Object.defineProperty(targetGlobal, STATE_KEY, {
      value: { blocked: [], installed: false },
      configurable: false,
      enumerable: false,
      writable: false,
    });
  }
  return targetGlobal[STATE_KEY];
}

function ipv6IsLoopback(value) {
  const input = value.toLowerCase().split("%")[0];
  if (input === "::1") return true;
  if (!input.includes(":")) return false;

  let address = input;
  let ipv4Tail = null;
  const lastColon = address.lastIndexOf(":");
  const tail = address.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (net.isIP(tail) !== 4) return false;
    const bytes = tail.split(".").map(Number);
    ipv4Tail = `${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
    address = `${address.slice(0, lastColon + 1)}${ipv4Tail}`;
  }

  const halves = address.split("::");
  if (halves.length > 2) return false;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return false;
  const groups = [...left, ...Array(Math.max(0, missing)).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return false;
  return groups.slice(0, 7).every((group) => parseInt(group, 16) === 0) && parseInt(groups[7], 16) === 1;
}

function isLoopbackHost(rawHost) {
  if (rawHost === undefined || rawHost === null || rawHost === "") return true;
  let host = String(rawHost).trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  host = host.replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (net.isIP(host) === 4) {
    const octets = host.split(".").map(Number);
    return octets.length === 4 && octets[0] === 127;
  }
  return ipv6IsLoopback(host);
}

function recordAndThrow(host, api) {
  const normalizedHost = String(host || "<unknown>");
  state().blocked.push({ host: normalizedHost, api });
  const error = new Error(
    `Test network guard blocked non-loopback network access to "${normalizedHost}" via ${api}; only 127.0.0.0/8, ::1, localhost, and Unix sockets are allowed.`,
  );
  error.code = "ERR_TEST_NETWORK_BLOCKED";
  throw error;
}

function assertHostAllowed(host, api) {
  if (!isLoopbackHost(host)) recordAndThrow(host, api);
}

function urlHost(value) {
  if (value instanceof URL) return value.hostname;
  if (typeof value === "string" && /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      return new URL(value).hostname;
    } catch {
      return "<invalid-url>";
    }
  }
  if (value && typeof value === "object" && typeof value.url === "string") {
    return urlHost(value.url);
  }
  return null;
}

function optionsArgument(args) {
  return args.find((arg) => arg && typeof arg === "object" && !(arg instanceof URL)) || {};
}

function httpHost(args) {
  const first = args[0];
  const options = first && typeof first === "object" && !(first instanceof URL)
    ? first
    : optionsArgument(args.slice(1));
  const fromUrl = urlHost(first);
  if (fromUrl !== null) return options.hostname || options.host || fromUrl;
  if (typeof first === "string") {
    const parsed = urlHost(first);
    if (parsed !== null) return options.hostname || options.host || parsed;
  }
  if (options.socketPath) return null;
  return options.hostname || options.host || "localhost";
}

function patch(target, key, api, getHost) {
  const original = target?.[key];
  if (typeof original !== "function" || original[WRAPPED]) return;
  const guarded = function (...args) {
    const destination = getHost(args);
    if (destination !== null) assertHostAllowed(destination, api);
    return Reflect.apply(original, this, args);
  };
  Object.defineProperty(guarded, WRAPPED, { value: true });
  target[key] = guarded;
}

function connectionHost(args) {
  const first = args[0];
  if (typeof first === "string") {
    // net.connect(string) and tls.connect({ path }) use Unix sockets.
    if (!/^\s*\d+\s*$/.test(first) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(first)) return null;
    const parsed = urlHost(first);
    return parsed ?? "localhost";
  }
  const options = first && typeof first === "object" ? first : {};
  if (options.path || options.socketPath) return null;
  if (typeof first === "number") {
    const candidate = args[1];
    if (typeof candidate === "string") return candidate;
    if (candidate && typeof candidate === "object") {
      if (candidate.path || candidate.socketPath) return null;
      return candidate.host || candidate.hostname || "localhost";
    }
  }
  return options.host || options.hostname || options.servername || "localhost";
}

function dnsHost(args) {
  return args[0];
}

let builtinsInstalled = false;

function install(targetGlobal = globalThis) {
  const current = state(targetGlobal);
  current.installed = true;

  const nativeFetch = targetGlobal.fetch;
  if (typeof nativeFetch === "function" && !nativeFetch[WRAPPED]) {
    const guardedFetch = function (input, init) {
      const host = urlHost(input);
      assertHostAllowed(host ?? "<invalid-url>", "globalThis.fetch");
      return Reflect.apply(nativeFetch, this, [input, init]);
    };
    Object.defineProperty(guardedFetch, WRAPPED, { value: true });
    targetGlobal.fetch = guardedFetch;
  }

  if (builtinsInstalled) return current;
  builtinsInstalled = true;

  for (const module of [http, https]) {
    patch(module, "request", `${module === https ? "node:https" : "node:http"}.request`, httpHost);
    patch(module, "get", `${module === https ? "node:https" : "node:http"}.get`, httpHost);
  }

  patch(net, "connect", "node:net.connect", connectionHost);
  patch(net, "createConnection", "node:net.createConnection", connectionHost);
  patch(tls, "connect", "node:tls.connect", connectionHost);

  const dnsNames = [
    "lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny",
    "resolveCaa", "resolveCname", "resolveMx", "resolveNaptr", "resolveNs",
    "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt", "reverse",
  ];
  for (const name of dnsNames) {
    patch(dns, name, `node:dns.${name}`, dnsHost);
    patch(dnsPromises, name, `node:dns/promises.${name}`, dnsHost);
    patch(dns.Resolver?.prototype, name, `node:dns.Resolver.${name}`, dnsHost);
    patch(dnsPromises.Resolver?.prototype, name, `node:dns/promises.Resolver.${name}`, dnsHost);
  }
  syncBuiltinESMExports();
  return current;
}

function clearBlockedAttempts() {
  state().blocked.length = 0;
}

install();

module.exports = {
  clearBlockedAttempts,
  install,
  isLoopbackHost,
  isFetchGuarded(targetGlobal = globalThis) {
    return Boolean(targetGlobal.fetch?.[WRAPPED]);
  },
  state,
};
