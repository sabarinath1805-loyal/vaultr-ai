import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validSpreadsheetBuffer } from "../../../../__tests__/fixtures/spreadsheetBuffer";
import type { DocStore, ToolCall } from "../types";

const mocks = vi.hoisted(() => ({ downloadFile: vi.fn() }));

vi.mock("../../../../lib/storage", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../lib/storage")>();
  return { ...actual, downloadFile: mocks.downloadFile };
});

import { runToolCalls } from "./toolDispatcher";

const MALFORMED_XLSX = Buffer.from("504b03041400060008000000", "hex");

function arrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

function storeWithWorkbook(): DocStore {
  return new Map([
    [
      "doc-0",
      {
        storage_path: "documents/owner-a/budget.xlsx",
        file_type: "xlsx",
        filename: "Budget.xlsx",
      },
    ],
  ]);
}

function readCall(docId: string): ToolCall[] {
  return [
    {
      id: "read-spreadsheet",
      function: {
        name: "read_document",
        arguments: JSON.stringify({ doc_id: docId }),
      },
    },
  ];
}

async function runReadDocument(docId: string, store: DocStore) {
  return runToolCalls(
    readCall(docId),
    store,
    "user-a",
    {} as never,
    () => undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "spreadsheet-read-test",
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("read_document spreadsheet parser boundary", () => {
  it("uses isolated parsing and preserves the citation-ready result", async () => {
    const store = storeWithWorkbook();
    mocks.downloadFile.mockResolvedValueOnce(
      arrayBuffer(validSpreadsheetBuffer()),
    );

    const result = await runReadDocument("doc-0", store);
    const tool = result.toolResults[0] as { content: string };

    expect(tool.content).toContain("## Sheet: Q1 | Budget");
    expect(tool.content).toContain("| 2 | Total | $1,200 | $1,200 |");
    expect(result.docsRead).toEqual([
      {
        filename: "Budget.xlsx",
        document_id: undefined,
        version_id: null,
        version_number: null,
      },
    ]);
  });

  it("returns controlled failure without partial bytes or authorization bypass", async () => {
    vi.stubEnv("SPREADSHEET_PARSE_TIMEOUT_MS", "1000");
    const store = storeWithWorkbook();
    mocks.downloadFile.mockResolvedValueOnce(arrayBuffer(MALFORMED_XLSX));

    const result = await runReadDocument("doc-0", store);
    const tool = result.toolResults[0] as { content: string };

    expect(tool.content).toContain("Document could not be read.");
    expect(tool.content).not.toContain("504b03041400060008000000");
    expect(tool.content).not.toContain("SpreadsheetParseError");

    mocks.downloadFile.mockClear();
    const denied = await runReadDocument("foreign-document-id", store);
    expect((denied.toolResults[0] as { content: string }).content).toContain(
      "Document not found.",
    );
    expect(mocks.downloadFile).not.toHaveBeenCalled();
  }, 10_000);
});
