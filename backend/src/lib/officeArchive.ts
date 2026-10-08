import JSZip from "jszip";

// JSZip documents internalStream as its non-accumulating streaming API, but
// its bundled TypeScript declarations omit this method on JSZipObject.
interface OfficeEntryStream {
  on(event: "data", callback: (chunk: Uint8Array) => void): void;
  on(event: "error", callback: (error: unknown) => void): void;
  on(event: "end", callback: () => void): void;
  pause(): void;
  resume(): void;
}

export type OfficeArchiveLimits = { maxExpandedBytes: number; maxEntries: number };
// Uploads allow 100 MiB compressed. Expansion is independently bounded to
// 128 MiB across all entries (including images), with at most 10,000 entries.
// These are deliberate parser admission limits, not a process RSS guarantee.
export const OFFICE_ARCHIVE_LIMITS: Readonly<OfficeArchiveLimits> = Object.freeze({
  maxExpandedBytes: 128 * 1024 * 1024,
  maxEntries: 10_000,
});

export class OfficeArchiveError extends Error {
  constructor(readonly code: "expanded_size" | "entry_count" | "invalid_archive") {
    super("Office document could not be read within the archive processing limits.");
    this.name = "OfficeArchiveError";
  }
}

/** Validate actual expanded bytes before any XML parser or Mammoth runs. */
export async function loadOfficeArchive(
  bytes: Buffer,
  limits: Readonly<OfficeArchiveLimits> = OFFICE_ARCHIVE_LIMITS,
): Promise<JSZip> {
  if (!Number.isSafeInteger(limits.maxExpandedBytes) || limits.maxExpandedBytes < 1 ||
      !Number.isSafeInteger(limits.maxEntries) || limits.maxEntries < 1) {
    throw new RangeError("Office archive limits must be positive safe integers");
  }
  try {
    const zip = await JSZip.loadAsync(bytes);
    const entries = Object.values(zip.files);
    if (entries.length > limits.maxEntries) throw new OfficeArchiveError("entry_count");
    let expanded = 0;
    for (const entry of entries) {
      if (entry.dir) continue;
      // Use JSZip's public streaming interface, retaining no decompressed
      // output. Pausing the helper also pauses its upstream worker; destroying
      // JSZip's legacy Node adapter does not cancel that upstream worker.
      await new Promise<void>((resolve, reject) => {
        const stream = (entry as typeof entry & {
          internalStream(type: "uint8array"): OfficeEntryStream;
        }).internalStream("uint8array");
        let rejected = false;
        stream.on("data", (chunk: Uint8Array) => {
          if (rejected) return;
          expanded += chunk.byteLength;
          if (expanded > limits.maxExpandedBytes) {
            rejected = true;
            stream.pause();
            reject(new OfficeArchiveError("expanded_size"));
          }
        });
        stream.on("error", reject);
        stream.on("end", resolve);
        stream.resume();
      });
    }
    return zip;
  } catch (error) {
    if (error instanceof OfficeArchiveError) throw error;
    throw new OfficeArchiveError("invalid_archive");
  }
}
