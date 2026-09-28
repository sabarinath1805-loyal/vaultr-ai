import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { app } from "../../app";
import { validSpreadsheetBuffer } from "../fixtures/spreadsheetBuffer";
import { spreadsheetToLLMText } from "../../lib/spreadsheet";

const MALFORMED_XLSX = Buffer.from("504b03041400060008000000", "hex");

function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`operation exceeded ${timeoutMs}ms`)),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

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

describe("spreadsheet parser backend responsiveness", () => {
  it("kills the exact malformed parser while health and unrelated work complete", async () => {
    vi.stubEnv("SPREADSHEET_PARSE_TIMEOUT_MS", "3000");
    let notifyParserStarted: ((pid: number) => void) | undefined;
    const parserStarted = new Promise<number>((resolve) => {
      notifyParserStarted = resolve;
    });
    let settled = false;
    const parseOutcome = spreadsheetToLLMText(MALFORMED_XLSX, {
      onParserStarted: (pid) => notifyParserStarted?.(pid),
    }).then(
      (markdown) => {
        settled = true;
        return { kind: "resolved" as const, markdown };
      },
      (error: unknown) => {
        settled = true;
        return { kind: "rejected" as const, error };
      },
    );

    const childPid = await within(parserStarted, 3_000);
    const requestStart = Date.now();
    const [health, unrelated] = await within(
      Promise.all([
        request(app).get("/health"),
        request(app).get("/manifest-signing-key"),
      ]),
      2_000,
    );
    const requestElapsedMs = Date.now() - requestStart;

    expect(health.status).toBe(200);
    expect(health.body).toEqual({ ok: true });
    expect(unrelated.status).toBe(200);
    expect(settled).toBe(false);

    // A second independent parse gets the remaining bounded child slot and
    // completes while the malformed parse is still consuming its own process.
    const competingMarkdown = await within(
      spreadsheetToLLMText(validSpreadsheetBuffer()),
      3_000,
    );
    expect(competingMarkdown).toContain("$1,200");
    expect(settled).toBe(false);

    const outcome = await within(parseOutcome, 5_000);
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.error).toMatchObject({
        name: "SpreadsheetParseError",
        code: "timeout",
      });
      expect((outcome.error as Error).message).not.toMatch(
        /xlsx|sheetjs|\/Users\//i,
      );
    }
    expect(processExists(childPid)).toBe(false);

    // The parser slot is released only after the timed-out child has closed.
    const laterMarkdown = await spreadsheetToLLMText(validSpreadsheetBuffer());
    expect(laterMarkdown).toContain("## Sheet: Q1 | Budget");
    expect(requestElapsedMs).toBeLessThan(2_000);
  }, 15_000);
});
