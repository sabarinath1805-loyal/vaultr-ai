import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import { spreadsheetParsingConfiguration } from "./runtimeConfig";

/** Maximum number of simultaneous parser children for one backend process. */
export const MAX_CONCURRENT_SPREADSHEET_PARSERS = 2;

// This limits the child V8 heap. It is not an operating-system RSS limit.
const SPREADSHEET_PARSER_HEAP_MB = 256;
let activeParsers = 0;

export type SpreadsheetParseErrorCode =
  "busy" | "timeout" | "cancelled" | "parse_failed" | "worker_failed";

const ERROR_MESSAGES: Record<SpreadsheetParseErrorCode, string> = {
  busy: "Spreadsheet readers are busy. Please try again.",
  timeout: "Spreadsheet could not be read within the processing limit.",
  cancelled: "Spreadsheet reading was cancelled.",
  parse_failed: "Spreadsheet could not be read.",
  worker_failed: "Spreadsheet processing failed.",
};

/** Safe, categorized parser failure; it never contains SheetJS details. */
export class SpreadsheetParseError extends Error {
  constructor(readonly code: SpreadsheetParseErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "SpreadsheetParseError";
  }
}

export type SpreadsheetParseOptions = {
  signal?: AbortSignal;
  /** Notifies instrumentation after the isolated child is ready to parse. */
  onParserStarted?: (pid: number) => void;
};

type ChildMessage =
  | { type: "started"; pid: number }
  | { type: "result"; text: string }
  | { type: "parse_error" };

/**
 * Extract a spreadsheet as cell-addressed markdown for the LLM. SheetJS runs
 * in a fresh, killable child process; the shared API event loop never executes
 * the synchronous parser.
 */
export async function spreadsheetToLLMText(
  buffer: Buffer,
  options: SpreadsheetParseOptions = {},
): Promise<string> {
  if (options.signal?.aborted) {
    throw new SpreadsheetParseError("cancelled");
  }
  if (activeParsers >= MAX_CONCURRENT_SPREADSHEET_PARSERS) {
    throw new SpreadsheetParseError("busy");
  }

  activeParsers++;
  try {
    const { timeoutMs } = spreadsheetParsingConfiguration();
    return await parseInChild(buffer, timeoutMs, options);
  } finally {
    activeParsers--;
  }
}

function parseInChild(
  buffer: Buffer,
  timeoutMs: number,
  options: SpreadsheetParseOptions,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const extension = __filename.endsWith(".ts") ? "ts" : "js";
    let child: ChildProcess;
    try {
      child = fork(
        path.join(__dirname, `spreadsheetParserChild.${extension}`),
        [],
        {
          execArgv: [
            ...(extension === "ts" ? ["--import", "tsx"] : []),
            `--max-old-space-size=${SPREADSHEET_PARSER_HEAP_MB}`,
          ],
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          serialization: "advanced",
          // Parser children need no deployment credentials or network config.
          env: { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH },
        },
      );
    } catch {
      reject(new SpreadsheetParseError("worker_failed"));
      return;
    }

    let result: string | undefined;
    let failure: SpreadsheetParseError | undefined;
    let settled = false;
    let timer: NodeJS.Timeout;

    const settleAfterClose = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (failure) reject(failure);
      else if (result !== undefined) resolve(result);
      else reject(new SpreadsheetParseError("worker_failed"));
    };

    const terminate = (error: SpreadsheetParseError) => {
      failure ??= error;
      child.kill("SIGKILL");
    };

    const onAbort = () => terminate(new SpreadsheetParseError("cancelled"));

    child.on("message", (message: ChildMessage) => {
      if (message?.type === "started") {
        try {
          options.onParserStarted?.(message.pid);
        } catch {
          // A diagnostic callback must never affect parser execution.
        }
        return;
      }
      if (message?.type === "result" && typeof message.text === "string") {
        result = message.text;
        // The response is fully received; kill the child now and settle only
        // once the OS reports it closed, so no parser process is left behind.
        child.kill("SIGKILL");
        return;
      }
      if (message?.type === "parse_error") {
        failure = new SpreadsheetParseError("parse_failed");
        child.kill("SIGKILL");
        return;
      }
      terminate(new SpreadsheetParseError("worker_failed"));
    });

    child.once("error", () => {
      terminate(new SpreadsheetParseError("worker_failed"));
    });
    child.once("close", settleAfterClose);

    timer = setTimeout(
      () => terminate(new SpreadsheetParseError("timeout")),
      timeoutMs,
    );
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    if (!failure) {
      child.send({ buffer }, (error) => {
        if (error) terminate(new SpreadsheetParseError("worker_failed"));
      });
    }
  });
}
