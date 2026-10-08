import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { loadOfficeArchive, OfficeArchiveError } from "../officeArchive";

const limits = { maxExpandedBytes: 20 * 1024, maxEntries: 10 };
async function archive(entries: Record<string, string>) {
  const zip = new JSZip();
  for (const [name, text] of Object.entries(entries)) zip.file(name, text);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

describe("Office archive admission bounds", () => {
  it("rejects compressed XML expansion before returning an archive", async () => {
    const bytes = await archive({ "word/document.xml": "A".repeat(2 * 1024 * 1024) });
    expect(bytes.length).toBeLessThan(limits.maxExpandedBytes);
    await expect(loadOfficeArchive(bytes, limits)).rejects.toMatchObject({ code: "expanded_size" });
  });
  it("bounds aggregate expansion, including non-XML assets", async () => {
    const bytes = await archive({ "slide.xml": "A".repeat(12_000), "image.bin": "B".repeat(12_000) });
    await expect(loadOfficeArchive(bytes, limits)).rejects.toMatchObject({ code: "expanded_size" });
  });
  it("bounds entry count even when entries contain no content", async () => {
    const bytes = await archive(Object.fromEntries(Array.from({ length: 11 }, (_, i) => [String(i), ""])));
    await expect(loadOfficeArchive(bytes, limits)).rejects.toMatchObject({ code: "entry_count" });
  });
  it("does not trust forged understated central-directory expansion sizes", async () => {
    const bytes = await archive({ "document.xml": "A".repeat(100_000) });
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(central).toBeGreaterThan(0);
    bytes.writeUInt32LE(1, central + 24);
    await expect(loadOfficeArchive(bytes, limits)).rejects.toMatchObject({ code: "expanded_size" });
  });
  it("preserves normal entries and accepts the exact aggregate boundary", async () => {
    const bytes = await archive({ "word/document.xml": "<w:document>normal</w:document>", "media.bin": "image" });
    const maxExpandedBytes = Buffer.byteLength("<w:document>normal</w:document>image");
    const zip = await loadOfficeArchive(bytes, { maxExpandedBytes, maxEntries: 3 });
    await expect(zip.file("word/document.xml")!.async("text")).resolves.toBe("<w:document>normal</w:document>");
  });
  it("rejects malformed archives with an opaque categorized error", async () => {
    await expect(loadOfficeArchive(Buffer.from("not an archive"), limits)).rejects.toBeInstanceOf(OfficeArchiveError);
  });
});
