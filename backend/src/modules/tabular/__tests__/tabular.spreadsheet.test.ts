import { describe, expect, it } from "vitest";
import { validSpreadsheetBuffer } from "../../../__tests__/fixtures/spreadsheetBuffer";
import { extractDocumentMarkdown } from "../tabular.extract";

function arrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

describe("Tabular Review spreadsheet extraction", () => {
  it("uses the isolated cell-addressed parser for workbook context", async () => {
    const markdown = await extractDocumentMarkdown(
      arrayBuffer(validSpreadsheetBuffer()),
      "XLSX",
    );

    expect(markdown).toContain("## Sheet: Q1 | Budget");
    expect(markdown).toContain("Merged ⟨merged A3:B3⟩");
    expect(markdown).toContain("## Sheet: Notes");
  });
});
