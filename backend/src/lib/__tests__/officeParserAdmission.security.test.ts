import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";

// Exercise real streaming admission with a small policy, avoiding huge inputs.
vi.mock("../officeArchive", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../officeArchive")>();
  return {
    ...actual,
    loadOfficeArchive: (bytes: Buffer) => actual.loadOfficeArchive(bytes, {
      maxExpandedBytes: 20 * 1024, maxEntries: 10,
    }),
  };
});
const mammothConvert = vi.hoisted(() => vi.fn());
vi.mock("mammoth", () => ({ convertToHtml: mammothConvert }));
import {
  extractDocxBodyText, extractTrackedChangeIds, applyTrackedEdits, resolveTrackedChange,
} from "../docxTrackedChanges";
import { extractPresentationText } from "../officeText";
import { extractDocxMarkdown } from "../../modules/tabular/tabular.extract";

async function oversizedArchive() {
  const zip = new JSZip();
  zip.file("word/document.xml", "A".repeat(24 * 1024));
  zip.file("ppt/slides/slide1.xml", "<a:t>safe</a:t>");
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

describe("Office parser admission integration", () => {
  it("rejects expansion before all tracked-change read/write entry points", async () => {
    const bytes = await oversizedArchive();
    for (const operation of [
      () => extractDocxBodyText(bytes),
      () => extractTrackedChangeIds(bytes),
      () => applyTrackedEdits(bytes, []),
      () => resolveTrackedChange(bytes, [], "accept"),
    ]) await expect(operation()).rejects.toMatchObject({ code: "expanded_size" });
  });
  it("checks all presentation archive assets, not just selected slide XML", async () => {
    await expect(extractPresentationText(await oversizedArchive())).rejects.toMatchObject({ code: "expanded_size" });
  });
  it("propagates tabular admission failures before normalization/Mammoth fallback", async () => {
    const bytes = await oversizedArchive();
    await expect(extractDocxMarkdown(Uint8Array.from(bytes).buffer)).rejects.toMatchObject({ code: "expanded_size" });
    expect(mammothConvert).not.toHaveBeenCalled();
  });
});
