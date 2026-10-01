import { spawnSync } from "node:child_process";
import tls from "node:tls";
import { pathToFileURL } from "node:url";
import {
  cancelBody,
  combineResults,
  headerValue,
  hostOnly,
  httpsTarget,
  oneLineResult,
  parseInvocation,
  resolveTargetSafety,
} from "./common.mjs";

const TIMEOUT_MS = 5_000;

export function classifyTlsAndRedirect(evidence, now = Date.now()) {
  const outcomes = [];
  const redirect = evidence.http;
  if (!redirect?.location || ![301, 302, 307, 308].includes(redirect.status)) {
    outcomes.push(["FAIL", "HTTP did not redirect to HTTPS"]);
  } else {
    try {
      const destination = new URL(redirect.location, evidence.httpUrl);
      if (destination.protocol !== "https:" || destination.host !== evidence.httpsUrl.host) {
        outcomes.push(["FAIL", "HTTP redirect does not stay on this HTTPS hostname"]);
      } else {
        outcomes.push(["PASS", "HTTP redirects to this HTTPS hostname"]);
      }
    } catch {
      outcomes.push(["FAIL", "HTTP redirect destination is invalid"]);
    }
  }

  const response = evidence.https;
  if (!response || response.status < 200 || response.status >= 500) {
    outcomes.push(["FAIL", "HTTPS endpoint did not return a usable response"]);
  } else {
    const hsts = headerValue(response.headers, "strict-transport-security");
    if (/max-age\s*=\s*[1-9]\d*/i.test(hsts)) {
      outcomes.push(["PASS", "HTTPS response includes active HSTS"]);
    } else {
      outcomes.push(["FAIL", "HTTPS response is missing active HSTS"]);
    }
  }

  const certificate = evidence.certificate;
  if (!certificate?.validTo || !certificate.validFrom) {
    outcomes.push(["FAIL", "TLS certificate details could not be read"]);
  } else {
    const expiry = Date.parse(certificate.validTo);
    const starts = Date.parse(certificate.validFrom);
    if (!Number.isFinite(expiry) || !Number.isFinite(starts) || expiry <= now || starts > now) {
      outcomes.push(["FAIL", "TLS certificate is expired or not yet valid"]);
    } else if (certificate.identityError || certificate.authorizationError) {
      outcomes.push(["FAIL", "TLS certificate identity or trust validation failed"]);
    } else {
      outcomes.push(["PASS", "TLS certificate is current and trusted for the hostname"]);
    }
  }

  if (!["TLSv1.2", "TLSv1.3"].includes(evidence.protocol)) {
    outcomes.push(["FAIL", "TLS negotiation did not use TLS 1.2 or newer"]);
  } else {
    outcomes.push(["PASS", `TLS negotiated ${evidence.protocol}`]);
  }

  for (const [label, result] of [
    ["TLS 1.0", evidence.weakTls10],
    ["TLS 1.1", evidence.weakTls11],
  ]) {
    if (result === "supported") outcomes.push(["FAIL", `${label} is accepted by the endpoint`]);
    else if (result === "not-supported") outcomes.push(["PASS", `${label} probe was rejected`]);
    else outcomes.push(["MANUAL", `${label} could not be conclusively tested by this machine`]);
  }
  return outcomes.map(([status, message]) => ({ status, message }));
}

function tlsEvidence(host, port = 443) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const options = {
      host,
      port,
      minVersion: "TLSv1.2",
      rejectUnauthorized: false,
    };
    if (!tls.isIP(host)) options.servername = host;
    const socket = tls.connect(options, () => {
      const peer = socket.getPeerCertificate();
      const identityError = peer && tls.checkServerIdentity(host, peer);
      finish({
        protocol: socket.getProtocol(),
        certificate: {
          validFrom: peer.valid_from,
          validTo: peer.valid_to,
          identityError: Boolean(identityError),
          authorizationError: socket.authorizationError ? String(socket.authorizationError) : "",
        },
      });
      socket.end();
    });
    socket.setTimeout(TIMEOUT_MS, () => {
      socket.destroy();
      finish({ protocol: "", certificate: null });
    });
    socket.once("error", () => finish({ protocol: "", certificate: null }));
  });
}

function weakProtocolProbe(host, version, port = 443) {
  const flags = version === "TLSv1" ? ["-tls1"] : ["-tls1_1"];
  const connectTarget = `${host.includes(":") ? `[${host}]` : host}:${port}`;
  const serverNameArgs = tls.isIP(host) ? [] : ["-servername", host];
  let result;
  try {
    result = spawnSync(
      "openssl",
      ["s_client", "-brief", "-connect", connectTarget, ...serverNameArgs, ...flags],
      { encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: 24 * 1024 },
    );
  } catch {
    return "unknown";
  }
  if (result.error?.code === "ENOENT" || result.error?.code === "ETIMEDOUT") return "unknown";
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const protocol = version === "TLSv1" ? /Protocol version:\s*TLSv1(?:\.0)?\b/i : /Protocol version:\s*TLSv1\.1\b/i;
  if (protocol.test(output)) return "supported";
  if (/alert protocol version|unsupported protocol version/i.test(output)) return "not-supported";
  return "unknown";
}

async function head(fetchImpl, url) {
  const response = await fetchImpl(url, {
    method: "HEAD",
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const result = { status: response.status, headers: response.headers, location: headerValue(response.headers, "location") };
  await cancelBody(response);
  return result;
}

export async function probeTlsAndRedirect({ target, fetchImpl = fetch, tlsProbe = tlsEvidence, weakProbe = weakProtocolProbe }) {
  const httpsUrl = httpsTarget(target);
  const host = hostOnly(httpsUrl.hostname);
  const port = Number(httpsUrl.port || 443);
  const httpUrl = new URL(httpsUrl);
  httpUrl.protocol = "http:";
  httpUrl.port = "";
  const [httpResponse, tlsInfo] = await Promise.all([
    head(fetchImpl, httpUrl),
    tlsProbe(host, port),
  ]);
  let httpsResponse = null;
  try {
    httpsResponse = await head(fetchImpl, httpsUrl);
  } catch {
    // Keep the report generic; TLS diagnostics never expose response content.
  }
  const [weakTls10, weakTls11] = await Promise.all([
    weakProbe(host, "TLSv1", port),
    weakProbe(host, "TLSv1.1", port),
  ]);
  return classifyTlsAndRedirect({
    http: httpResponse,
    httpUrl,
    https: httpsResponse,
    httpsUrl,
    protocol: tlsInfo.protocol,
    certificate: tlsInfo.certificate,
    weakTls10,
    weakTls11,
  });
}

async function main() {
  const parsed = parseInvocation(process.argv.slice(2));
  if (parsed.error) {
    console.log(oneLineResult("FAIL", parsed.error));
    return;
  }
  const target = parsed.positionals[0];
  let url;
  try {
    url = httpsTarget(target);
  } catch {
    console.log(oneLineResult("FAIL", "provide a valid HTTPS hostname or base URL"));
    return;
  }
  if (!parsed.run) {
    console.log(oneLineResult("MANUAL", `dry run only; would check TLS, redirect, certificate and HSTS for ${url.host}`));
    return;
  }
  const safety = await resolveTargetSafety(url.hostname);
  if (safety.status !== "PASS") {
    console.log(oneLineResult(safety.status, safety.message));
    return;
  }
  try {
    const results = await probeTlsAndRedirect({ target });
    for (const result of results) console.log(oneLineResult(result.status, result.message));
    console.log(oneLineResult(combineResults(results.map((result) => result.status)), "TLS and redirect probe complete"));
  } catch {
    console.log(oneLineResult("MANUAL", "the bounded TLS or HTTP probe could not complete; no target data was changed"));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
