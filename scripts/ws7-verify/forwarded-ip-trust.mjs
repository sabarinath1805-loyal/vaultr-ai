import { pathToFileURL } from "node:url";
import {
  cancelBody,
  combineResults,
  headerValue,
  httpsTarget,
  oneLineResult,
  parseInvocation,
  resolveTargetSafety,
} from "./common.mjs";

const TIMEOUT_MS = 5_000;
const BURST_SIZE = 4;
const FORGED_ADDRESSES = ["198.51.100.17", "203.0.113.48"];

export function classifyForwardedIpEvidence(observations) {
  if (observations.length !== BURST_SIZE) {
    return [{ status: "MANUAL", message: "probe did not collect the fixed four-response sample" }];
  }
  if (observations.some((item) => item.status !== 200)) {
    return [{ status: "MANUAL", message: "the harmless health endpoint did not return HTTP 200 for every request" }];
  }
  const remaining = observations.map((item) => Number(item.remaining));
  if (remaining.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    return [{ status: "MANUAL", message: "rate-limit remaining counters were not exposed as integers" }];
  }
  const deltas = remaining.slice(1).map((value, index) => remaining[index] - value);
  if (deltas.some((delta) => delta === 0)) {
    return [{ status: "FAIL", message: "rotating forged forwarding headers did not share one rate-limit counter" }];
  }
  if (deltas.every((delta) => delta === 1)) {
    return [{ status: "PASS", message: "all forged forwarding-header variants shared one sequential rate-limit counter" }];
  }
  return [{ status: "MANUAL", message: "concurrent traffic or a counter reset prevented a conclusive sequence" }];
}

export async function probeForwardedIpTrust({ target, fetchImpl = fetch, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const frontend = httpsTarget(target);
  const health = new URL("/api/health", frontend.origin);
  const observations = [];
  for (let index = 0; index < BURST_SIZE; index += 1) {
    const address = FORGED_ADDRESSES[index % FORGED_ADDRESSES.length];
    const response = await fetchImpl(health, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        "X-Forwarded-For": address,
        "X-Real-IP": address,
        Forwarded: `for=${address}`,
      },
    });
    observations.push({
      status: response.status,
      remaining: headerValue(response.headers, "ratelimit-remaining"),
    });
    await cancelBody(response);
    if (index < BURST_SIZE - 1) await pause(150);
  }
  return classifyForwardedIpEvidence(observations);
}

async function main() {
  const parsed = parseInvocation(process.argv.slice(2));
  if (parsed.error) {
    console.log(oneLineResult("FAIL", parsed.error));
    return;
  }
  let target;
  try {
    target = httpsTarget(parsed.positionals[0]);
  } catch {
    console.log(oneLineResult("FAIL", "provide the public HTTPS frontend origin"));
    return;
  }
  if (!parsed.run) {
    console.log(oneLineResult("MANUAL", `dry run only; would send four read-only GET requests to ${target.host}/api/health with rotating forged forwarding headers`));
    return;
  }
  const safety = await resolveTargetSafety(target.hostname);
  if (safety.status !== "PASS") {
    console.log(oneLineResult(safety.status, safety.message));
    return;
  }
  try {
    const results = await probeForwardedIpTrust({ target: target.origin });
    for (const result of results) console.log(oneLineResult(result.status, result.message));
    console.log(oneLineResult(combineResults(results.map((result) => result.status)), "forwarded-IP probe complete; only temporary limiter counters were touched"));
  } catch {
    console.log(oneLineResult("MANUAL", "the bounded health requests could not complete; no application records were written"));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
