import { pathToFileURL } from "node:url";
import {
  cancelBody,
  combineResults,
  httpsTarget,
  oneLineResult,
  parseInvocation,
  resolveTargetSafety,
} from "./common.mjs";

const TIMEOUT_MS = 5_000;

export function anonymousAccessResult(label, status) {
  if (status === 401 || status === 403) return { status: "PASS", message: `anonymous ${label} is denied` };
  if (status >= 200 && status < 300) return { status: "FAIL", message: `anonymous ${label} succeeded with HTTP ${status}` };
  if (status === 404) return { status: "MANUAL", message: `anonymous ${label} returned 404; confirm the bucket or object URL is correct` };
  if (status >= 300 && status < 400) return { status: "MANUAL", message: `anonymous ${label} redirected; review the endpoint and destination` };
  return { status: "MANUAL", message: `anonymous ${label} returned HTTP ${status}; access policy is inconclusive` };
}

function cleanPublicUrl(raw) {
  const url = httpsTarget(raw);
  if (url.search || url.hash) throw new Error("query and fragment data are not accepted");
  return url;
}

export async function probePublicBucket({ bucketTarget, objectTarget = "", fetchImpl = fetch }) {
  const bucketUrl = cleanPublicUrl(bucketTarget);
  const listing = new URL(bucketUrl);
  listing.searchParams.set("list-type", "2");
  listing.searchParams.set("max-keys", "1");
  const listResponse = await fetchImpl(listing, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const listResult = anonymousAccessResult("bucket listing", listResponse.status);
  await cancelBody(listResponse);

  if (!objectTarget) {
    return [
      listResult,
      { status: "MANUAL", message: "provide --object with a known object URL to verify anonymous reads" },
    ];
  }
  const objectUrl = cleanPublicUrl(objectTarget);
  if (objectUrl.origin !== bucketUrl.origin) {
    return [
      listResult,
      { status: "FAIL", message: "object URL must use the same origin as the explicit bucket target" },
    ];
  }
  const objectResponse = await fetchImpl(objectUrl, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const objectResult = anonymousAccessResult("object read", objectResponse.status);
  await cancelBody(objectResponse);
  return [listResult, objectResult];
}

async function main() {
  const parsed = parseInvocation(process.argv.slice(2), { options: ["object"] });
  if (parsed.error) {
    console.log(oneLineResult("FAIL", parsed.error));
    return;
  }
  let bucket;
  let object;
  try {
    bucket = cleanPublicUrl(parsed.positionals[0]);
    object = parsed.options.object ? cleanPublicUrl(parsed.options.object) : null;
  } catch {
    console.log(oneLineResult("FAIL", "provide HTTPS bucket and optional object URLs without credentials or query data"));
    return;
  }
  if (!parsed.run) {
    console.log(oneLineResult("MANUAL", `dry run only; would issue anonymous, read-only listing and object GET checks for ${bucket.host}`));
    return;
  }
  const safety = await resolveTargetSafety(bucket.hostname);
  if (safety.status !== "PASS") {
    console.log(oneLineResult(safety.status, safety.message));
    return;
  }
  try {
    const results = await probePublicBucket({ bucketTarget: bucket.href, objectTarget: object?.href ?? "" });
    for (const result of results) console.log(oneLineResult(result.status, result.message));
    console.log(oneLineResult(combineResults(results.map((result) => result.status)), "anonymous bucket-access probe complete"));
  } catch {
    console.log(oneLineResult("MANUAL", "the bounded anonymous GET requests could not complete; no target data was changed"));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
