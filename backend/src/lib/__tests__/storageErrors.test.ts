import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  getSignedUrl: vi.fn(),
  clientConfigs: [] as Array<Record<string, unknown>>,
}));

vi.mock("@aws-sdk/client-s3", () => {
  class S3Client {
    constructor(config: Record<string, unknown>) {
      mocks.clientConfigs.push(config);
    }
    send = mocks.send;
  }
  class Command {
    constructor(readonly input: unknown) {}
  }
  return {
    S3Client,
    PutObjectCommand: Command,
    DeleteObjectCommand: Command,
    ListObjectsV2Command: Command,
    GetObjectCommand: Command,
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: mocks.getSignedUrl,
}));

let downloadFile: typeof import("../storage").downloadFile;
let createFileReadStream: typeof import("../storage").createFileReadStream;
let getSignedUrl: typeof import("../storage").getSignedUrl;
let getSignedUploadUrl: typeof import("../storage").getSignedUploadUrl;
let uploadFileFromPath: typeof import("../storage").uploadFileFromPath;

beforeAll(async () => {
  process.env.R2_ENDPOINT_URL = "https://r2.example.test";
  process.env.R2_PUBLIC_ENDPOINT_URL = "";
  process.env.R2_ACCESS_KEY_ID = "test-access-key";
  process.env.R2_SECRET_ACCESS_KEY = "test-secret-key";
  vi.resetModules();
  ({
    createFileReadStream,
    downloadFile,
    getSignedUploadUrl,
    getSignedUrl,
    uploadFileFromPath,
  } = await import("../storage.js"));
});

beforeEach(() => {
  mocks.send.mockReset();
  mocks.getSignedUrl.mockReset();
  mocks.clientConfigs.length = 0;
});

describe("storage error logging", () => {
  it("uses the internal endpoint when the public upload endpoint is blank", async () => {
    mocks.getSignedUrl.mockResolvedValue("https://signed.example.test");

    await expect(
      getSignedUploadUrl("documents/u1/d1/source.pdf", "application/pdf", 1_234),
    ).resolves.toBe("https://signed.example.test");

    expect(mocks.clientConfigs.at(-1)).toMatchObject({
      endpoint: "https://r2.example.test",
    });
  });

  it("does not open an R2 GET until the returned stream is consumed", async () => {
    mocks.send.mockResolvedValue({
      Body: Readable.from([Buffer.from("first "), Buffer.from("second")]),
    });

    const stream = createFileReadStream("documents/u1/d1/source.pdf");
    expect(mocks.send).not.toHaveBeenCalled();

    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));

    expect(Buffer.concat(chunks).toString()).toBe("first second");
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("uploads a local file as a stream with an explicit content length", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mike-storage-test-"));
    const filePath = join(directory, "converted.pdf");
    await writeFile(filePath, Buffer.from("streamed pdf"));
    let uploaded = Buffer.alloc(0);
    mocks.send.mockImplementation(async (command: unknown) => {
      const input = (
        command as {
          input: {
            Body: Readable;
            ContentLength: number;
            ContentType: string;
          };
        }
      ).input;
      const chunks: Buffer[] = [];
      for await (const chunk of input.Body) chunks.push(Buffer.from(chunk));
      uploaded = Buffer.concat(chunks);
      expect(input.ContentLength).toBe(12);
      expect(input.ContentType).toBe("application/pdf");
      return {};
    });

    try {
      await uploadFileFromPath(
        "converted-pdfs/user/document.pdf",
        filePath,
        "application/pdf",
      );
      expect(uploaded.toString()).toBe("streamed pdf");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("logs download failures with the object key and a safe error", async () => {
    const failure = new Error("download failed");
    mocks.send.mockRejectedValue(failure);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      downloadFile("documents/u1/d1/source.pdf"),
    ).resolves.toBeNull();

    expect(log).toHaveBeenCalledWith("[storage] downloadFile failed", {
      key: "documents/u1/d1/source.pdf",
      error: expect.objectContaining({
        name: "Error",
        message: "download failed",
      }),
    });
    log.mockRestore();
  });

  it("redacts generic presign failures while retaining a correlation id", async () => {
    const key = "private/path/secret-object-key.pdf";
    const failure = new Error("provider response contains secret detail");
    mocks.getSignedUrl.mockRejectedValue(failure);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(getSignedUrl(key)).resolves.toBeNull();

    expect(log).toHaveBeenCalledWith(
      "[storage] presign failed",
      expect.objectContaining({
        operation: "getSignedUrl",
        error_code: "PRESIGN_FAILED",
        correlation_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      }),
    );
    const serializedLogs = JSON.stringify(log.mock.calls);
    expect(serializedLogs).not.toContain(key);
    expect(serializedLogs).not.toContain("provider response contains secret detail");
    log.mockRestore();
  });

  it("redacts signed upload presign failures too", async () => {
    const key = "upload-sessions/u1/s1/private-staging-key";
    mocks.getSignedUrl.mockRejectedValue(new Error("raw provider failure text"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      getSignedUploadUrl(key, "application/pdf", 1234),
    ).resolves.toBeNull();

    expect(log).toHaveBeenCalledWith(
      "[storage] presign failed",
      expect.objectContaining({
        operation: "getSignedUploadUrl",
        error_code: "PRESIGN_FAILED",
        correlation_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      }),
    );
    const serializedLogs = JSON.stringify(log.mock.calls);
    expect(serializedLogs).not.toContain(key);
    expect(serializedLogs).not.toContain("raw provider failure text");
    log.mockRestore();
  });
});
