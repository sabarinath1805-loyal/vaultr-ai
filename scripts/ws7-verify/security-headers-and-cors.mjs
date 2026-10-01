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
const HOSTILE_ORIGIN = "https://ws7-hostile-origin.invalid";

export function apiHealthUrl(apiTarget) {
  const api = httpsTarget(apiTarget);
  const prefix = api.pathname.replace(/\/+$/, "");
  api.pathname = `${prefix}/health` || "/health";
  api.search = "";
  api.hash = "";
  return api;
}

export function classifySecurityHeaders({ frontendHeaders, apiHeaders, preflight }) {
  const outcomes = [];
  for (const [label, headers] of [["frontend", frontendHeaders], ["API", apiHeaders]]) {
    const hsts = headerValue(headers, "strict-transport-security");
    const nosniff = headerValue(headers, "x-content-type-options").toLowerCase();
    const referrer = headerValue(headers, "referrer-policy").toLowerCase();
    const csp = headerValue(headers, "content-security-policy");
    const xfo = headerValue(headers, "x-frame-options").toLowerCase();
    if (/max-age\s*=\s*[1-9]\d*/i.test(hsts)) outcomes.push(["PASS", `${label} sends active HSTS`]);
    else outcomes.push(["FAIL", `${label} is missing active HSTS`]);
    if (nosniff === "nosniff") outcomes.push(["PASS", `${label} sends X-Content-Type-Options nosniff`]);
    else outcomes.push(["FAIL", `${label} is missing X-Content-Type-Options nosniff`]);
    if (referrer === "no-referrer" || referrer === "strict-origin" || referrer === "strict-origin-when-cross-origin") {
      outcomes.push(["PASS", `${label} sends a restrictive Referrer-Policy`]);
    } else outcomes.push(["FAIL", `${label} is missing a restrictive Referrer-Policy`]);
    if (/(?:default-src|script-src)\s/i.test(csp)) outcomes.push(["PASS", `${label} sends a Content-Security-Policy`]);
    else outcomes.push(["FAIL", `${label} is missing a Content-Security-Policy`]);
    if (/frame-ancestors\s+(?:'none'|'self'|https?:)/i.test(csp) || ["deny", "sameorigin"].includes(xfo)) {
      outcomes.push(["PASS", `${label} restricts framing`]);
    } else outcomes.push(["FAIL", `${label} is missing frame protection`]);
  }

  const allowOrigin = headerValue(preflight.headers, "access-control-allow-origin").trim();
  const credentials = headerValue(preflight.headers, "access-control-allow-credentials").toLowerCase() === "true";
  if (allowOrigin === "*" && credentials) {
    outcomes.push(["FAIL", "API combines wildcard CORS with credentialed requests"]);
  } else if (allowOrigin === HOSTILE_ORIGIN || allowOrigin === "*") {
    outcomes.push(["FAIL", "API preflight allows the hostile origin or all origins"]);
  } else if (preflight.status >= 200 && preflight.status < 300 && !allowOrigin) {
    outcomes.push(["PASS", "API preflight omits allow-origin for the hostile origin"]);
  } else if (preflight.status >= 400 && !allowOrigin) {
    outcomes.push(["PASS", "API rejects the hostile preflight"]);
  } else if (allowOrigin && allowOrigin !== HOSTILE_ORIGIN) {
    outcomes.push(["PASS", "API preflight does not allow the hostile origin"]);
  } else {
    outcomes.push(["MANUAL", "API preflight result was inconclusive; review its status and CORS headers"]);
  }
  return outcomes.map(([status, message]) => ({ status, message }));
}

async function requestHeaders(fetchImpl, url, init = {}) {
  const response = await fetchImpl(url, {
    method: "HEAD",
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    ...init,
  });
  const snapshot = { status: response.status, headers: response.headers };
  await cancelBody(response);
  return snapshot;
}

export async function probeSecurityHeadersAndCors({ frontendTarget, apiTarget, fetchImpl = fetch }) {
  const frontend = httpsTarget(frontendTarget);
  const apiHealth = apiHealthUrl(apiTarget);
  const [front, api] = await Promise.all([
    requestHeaders(fetchImpl, frontend),
    requestHeaders(fetchImpl, apiHealth),
  ]);
  const preflight = await requestHeaders(fetchImpl, apiHealth, {
    method: "OPTIONS",
    headers: {
      Origin: HOSTILE_ORIGIN,
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "authorization,content-type",
    },
  });
  return classifySecurityHeaders({
    frontendHeaders: front.headers,
    apiHeaders: api.headers,
    preflight,
  });
}

async function main() {
  const parsed = parseInvocation(process.argv.slice(2), { positionals: 2 });
  if (parsed.error) {
    console.log(oneLineResult("FAIL", parsed.error));
    return;
  }
  let frontend;
  let api;
  try {
    frontend = httpsTarget(parsed.positionals[0]);
    api = httpsTarget(parsed.positionals[1]);
  } catch {
    console.log(oneLineResult("FAIL", "provide HTTPS frontend and API base URLs"));
    return;
  }
  if (!parsed.run) {
    console.log(oneLineResult("MANUAL", `dry run only; would check headers and hostile-origin preflight for ${frontend.host} and ${api.host}`));
    return;
  }
  const safety = await Promise.all([
    resolveTargetSafety(frontend.hostname),
    resolveTargetSafety(api.hostname),
  ]);
  const unsafe = safety.find((result) => result.status !== "PASS");
  if (unsafe) {
    console.log(oneLineResult(unsafe.status, unsafe.message));
    return;
  }
  try {
    const results = await probeSecurityHeadersAndCors({
      frontendTarget: parsed.positionals[0],
      apiTarget: parsed.positionals[1],
    });
    for (const result of results) console.log(oneLineResult(result.status, result.message));
    console.log(oneLineResult(combineResults(results.map((result) => result.status)), "header and CORS probe complete"));
  } catch {
    console.log(oneLineResult("MANUAL", "the bounded HTTPS requests could not complete; no target data was changed"));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
