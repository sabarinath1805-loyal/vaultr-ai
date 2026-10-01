import net from "node:net";
import { pathToFileURL } from "node:url";
import { combineResults, hostOnly, oneLineResult, parseInvocation, resolveTargetSafety } from "./common.mjs";

const TIMEOUT_MS = 4_000;

export function parseHostPort(raw) {
  const url = new URL(`tcp://${raw}`);
  if (url.username || url.password || (url.pathname && url.pathname !== "/") || url.search || url.hash || !url.hostname || !url.port) {
    throw new Error("target must be one host and explicit TCP port");
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid port");
  return { host: hostOnly(url.hostname), port };
}

export function classifyReachability(outcome) {
  if (outcome === "open") return { status: "FAIL", message: "backend accepted a direct TCP connection; restrict its inbound network rule to the proxy" };
  if (outcome === "refused" || outcome === "timeout") return { status: "PASS", message: "backend port did not accept a direct TCP connection from this probe" };
  return { status: "MANUAL", message: "network path did not provide a conclusive direct-reachability result" };
}

export function probePort({ host, port, timeoutMs = TIMEOUT_MS, connectImpl = net.createConnection }) {
  return new Promise((resolve) => {
    const socket = connectImpl({ host, port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish("timeout"));
    socket.once("connect", () => finish("open"));
    socket.once("error", (error) => {
      if (error.code === "ECONNREFUSED") finish("refused");
      else if (error.code === "ETIMEDOUT") finish("timeout");
      else finish("unknown");
    });
  });
}

async function main() {
  const parsed = parseInvocation(process.argv.slice(2));
  if (parsed.error) {
    console.log(oneLineResult("FAIL", parsed.error));
    return;
  }
  let target;
  try {
    target = parseHostPort(parsed.positionals[0]);
  } catch {
    console.log(oneLineResult("FAIL", "provide an explicit backend host:port"));
    return;
  }
  if (!parsed.run) {
    console.log(oneLineResult("MANUAL", `dry run only; would make one bounded TCP connection attempt to ${target.host}:${target.port} from an external network`));
    return;
  }
  const safety = await resolveTargetSafety(target.host);
  if (safety.status !== "PASS") {
    console.log(oneLineResult(safety.status, safety.message));
    return;
  }
  try {
    const result = classifyReachability(await probePort(target));
    console.log(oneLineResult(result.status, `${result.message}; run from a network outside the deployment`));
    console.log(oneLineResult(combineResults([result.status]), "direct backend reachability probe complete"));
  } catch {
    console.log(oneLineResult("MANUAL", "the bounded TCP probe could not complete; no application data was accessed"));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
