import net from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

export function parseInvocation(argv, { positionals = 1, options = [] } = {}) {
  const values = { positionals: [], options: {}, run: false, owned: false, error: "" };
  const optionNames = new Set(options);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--run") {
      if (values.run) values.error = "--run was supplied more than once";
      values.run = true;
    } else if (arg === "--i-own-this-target") {
      if (values.owned) values.error = "--i-own-this-target was supplied more than once";
      values.owned = true;
    } else if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (!optionNames.has(name)) {
        values.error = `unsupported option ${arg}`;
      } else if (values.options[name] !== undefined) {
        values.error = `--${name} was supplied more than once`;
      } else if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) {
        values.error = `--${name} needs a value`;
      } else {
        values.options[name] = argv[i + 1];
        i += 1;
      }
    } else {
      values.positionals.push(arg);
    }
  }

  if (!values.error && values.positionals.length !== positionals) {
    values.error = `expected ${positionals} explicit target argument${positionals === 1 ? "" : "s"}`;
  }
  if (!values.error && values.run !== values.owned) {
    values.error = "live probes require both --run and --i-own-this-target";
  }
  return values;
}

export function httpsTarget(raw) {
  const value = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("target must be an HTTPS origin or HTTPS base URL without credentials or query data");
  }
  return url;
}

export function hostOnly(hostname) {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

export function isLoopbackHost(hostname) {
  const host = hostOnly(hostname);
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
  if (host.startsWith("127.")) return true;
  if (/^::ffff:127(?:\.\d{1,3}){3}$/.test(host)) return true;
  return net.isIP(host) === 4 && host.split(".")[0] === "127";
}

export function blockLoopbackTarget(hostname) {
  return isLoopbackHost(hostname)
    ? "refusing a loopback-only target; use the real public proxy for this check"
    : "";
}

export async function resolveTargetSafety(hostname, lookupImpl = dnsLookup) {
  const literal = hostOnly(hostname);
  const blocked = blockLoopbackTarget(literal);
  if (blocked) return { status: "FAIL", message: blocked };
  if (net.isIP(literal)) return { status: "PASS", message: "" };
  try {
    const records = await lookupImpl(literal, { all: true, verbatim: true });
    if (!records.length) {
      return { status: "MANUAL", message: "target DNS returned no addresses; no probe was sent" };
    }
    if (records.some((record) => isLoopbackHost(record.address))) {
      return { status: "FAIL", message: "refusing a target hostname that resolves to loopback" };
    }
    return { status: "PASS", message: "" };
  } catch {
    return { status: "MANUAL", message: "target DNS could not be resolved; no probe was sent" };
  }
}

export function oneLineResult(status, message) {
  return `${status}: ${message.replace(/[\r\n]+/g, " ").trim()}`;
}

export function combineResults(results) {
  if (results.includes("FAIL")) return "FAIL";
  if (results.includes("MANUAL")) return "MANUAL";
  return "PASS";
}

export function headerValue(headers, name) {
  if (headers && typeof headers.get === "function") return headers.get(name) ?? "";
  const key = Object.keys(headers ?? {}).find((item) => item.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key] ?? "") : "";
}

export async function cancelBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // A body may already be closed by the server or fetch implementation.
  }
}
