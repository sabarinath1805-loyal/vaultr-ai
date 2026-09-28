import { afterEach, describe, expect, it, vi } from "vitest";
import { validSpreadsheetBuffer } from "../../__tests__/fixtures/spreadsheetBuffer";
import { spreadsheetToLLMText, SpreadsheetParseError } from "../spreadsheet";

const MALFORMED_XLSX = Buffer.from("504b03041400060008000000", "hex");

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("spreadsheetToLLMText", () => {
  it.each([
    ["XLSX", "xlsx"],
    ["XLSM", "xlsm"],
    ["legacy XLS", "biff8"],
  ] as const)(
    "preserves cell-addressed output for %s",
    async (_label, type) => {
      const markdown = await spreadsheetToLLMText(validSpreadsheetBuffer(type));

      expect(markdown).toContain("## Sheet: Q1 | Budget");
      expect(markdown).toContain("| Row | A | B | C |");
      expect(markdown).toContain("| 1 | Budget\\|FY26 | 3/1/26 |  |");
      expect(markdown).toContain("| 2 | Total | $1,200 | $1,200 |");
      expect(markdown).toContain("Merged ⟨merged A3:B3⟩");
      expect(markdown).toContain("line\\|one line two");
      expect(markdown).toContain("## Sheet: Notes");
      expect(markdown).not.toContain("SUM(1000,200)");
    },
  );

  it("terminates an in-flight parser on caller cancellation and releases its slot", async () => {
    const controller = new AbortController();
    let childPid: number | undefined;
    let notifyStarted: (() => void) | undefined;
    const parserStarted = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const pending = spreadsheetToLLMText(MALFORMED_XLSX, {
      signal: controller.signal,
      onParserStarted: (pid) => {
        childPid = pid;
        notifyStarted?.();
      },
    });

    await parserStarted;
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      name: "SpreadsheetParseError",
      code: "cancelled",
    });
    expect(childPid).toBeDefined();
    expect(processExists(childPid!)).toBe(false);

    const markdown = await spreadsheetToLLMText(validSpreadsheetBuffer());
    expect(markdown).toContain("## Sheet: Q1 | Budget");
  }, 10_000);

  it("uses only safe, categorized application errors", async () => {
    vi.stubEnv("SPREADSHEET_PARSE_TIMEOUT_MS", "1000");
    const error = await spreadsheetToLLMText(MALFORMED_XLSX).then(
      () => null,
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(SpreadsheetParseError);
    expect(error).toMatchObject({ code: "timeout" });
    expect((error as Error).message).not.toMatch(/xlsx|sheetjs|\/Users\//i);
  }, 10_000);
});
