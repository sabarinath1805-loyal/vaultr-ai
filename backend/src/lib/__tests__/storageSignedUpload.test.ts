import { beforeAll, describe, expect, it, vi } from "vitest";

// Exercises the real AWS SDK signer: presigning is offline, so this catches
// query parameters the SDK adds on its own.
let getSignedUploadUrl: typeof import("../storage").getSignedUploadUrl;
let getSignedUrl: typeof import("../storage").getSignedUrl;
let SIGNED_DOCUMENT_GET_TTL_SECONDS: typeof import("../storage").SIGNED_DOCUMENT_GET_TTL_SECONDS;
let SIGNED_UPLOAD_PUT_TTL_SECONDS: typeof import("../storage").SIGNED_UPLOAD_PUT_TTL_SECONDS;
let MAX_SIGNED_URL_TTL_SECONDS: typeof import("../storage").MAX_SIGNED_URL_TTL_SECONDS;

function signedHeaders(url: string): string {
  return new URL(url).searchParams.get("X-Amz-SignedHeaders") ?? "";
}

function signedExpiry(url: string): number {
  return Number(new URL(url).searchParams.get("X-Amz-Expires"));
}

beforeAll(async () => {
  process.env.R2_ENDPOINT_URL = "https://account.r2.cloudflarestorage.com";
  process.env.R2_PUBLIC_ENDPOINT_URL = "";
  process.env.R2_ACCESS_KEY_ID = "test-access-key";
  process.env.R2_SECRET_ACCESS_KEY = "test-secret-key";
  process.env.R2_BUCKET_NAME = "mike";
  vi.resetModules();
  ({
    getSignedUploadUrl,
    getSignedUrl,
    SIGNED_DOCUMENT_GET_TTL_SECONDS,
    SIGNED_UPLOAD_PUT_TTL_SECONDS,
    MAX_SIGNED_URL_TTL_SECONDS,
  } = await import("../storage.js"));
});

describe("signed direct-upload URLs", () => {
  it("does not carry a checksum computed over the empty signable body", async () => {
    const url = await getSignedUploadUrl(
      "upload-sessions/u1/s1/f1/staging",
      "application/pdf",
      1_234,
    );

    expect(url).toBeTruthy();
    const parameters = new URL(url!).searchParams;
    expect(parameters.get("x-amz-checksum-crc32")).toBeNull();
    expect(parameters.get("x-amz-sdk-checksum-algorithm")).toBeNull();
  });

  it("signs the declared content type and byte count", async () => {
    const url = await getSignedUploadUrl(
      "upload-sessions/u1/s1/f1/staging",
      "application/pdf",
      1_234,
    );

    expect(signedHeaders(url!)).toBe("content-length;content-type;host");
  });

  it("produces a different signature for a different declared size", async () => {
    const [small, large] = await Promise.all([
      getSignedUploadUrl("upload-sessions/u1/s1/f1/staging", "application/pdf", 1_024),
      getSignedUploadUrl("upload-sessions/u1/s1/f1/staging", "application/pdf", 5_000_000),
    ]);

    expect(new URL(small!).searchParams.get("X-Amz-Signature")).not.toBe(
      new URL(large!).searchParams.get("X-Amz-Signature"),
    );
  });

  it("keeps upload PUT lifetime at 900 seconds and clamps larger requests", async () => {
    expect(SIGNED_UPLOAD_PUT_TTL_SECONDS).toBe(900);
    expect(MAX_SIGNED_URL_TTL_SECONDS).toBe(900);
    const defaultUrl = await getSignedUploadUrl(
      "upload-sessions/u1/s1/f1/staging",
      "application/pdf",
      1234,
    );
    const clampedUrl = await getSignedUploadUrl(
      "upload-sessions/u1/s1/f1/staging",
      "application/pdf",
      1234,
      3600,
    );

    expect(signedExpiry(defaultUrl!)).toBe(900);
    expect(signedExpiry(clampedUrl!)).toBe(900);
  });

  it("defaults document GET lifetime to 900 seconds and clamps larger requests", async () => {
    expect(SIGNED_DOCUMENT_GET_TTL_SECONDS).toBe(900);
    const defaultUrl = await getSignedUrl("documents/u1/d1/source.pdf");
    const shortUrl = await getSignedUrl("documents/u1/d1/source.pdf", 120);
    const clampedUrl = await getSignedUrl("documents/u1/d1/source.pdf", 3600);

    expect(signedExpiry(defaultUrl!)).toBe(900);
    expect(signedExpiry(shortUrl!)).toBe(120);
    expect(signedExpiry(clampedUrl!)).toBe(900);
  });
});
