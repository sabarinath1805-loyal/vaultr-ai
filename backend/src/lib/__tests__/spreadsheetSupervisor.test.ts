import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const { forkMock } = vi.hoisted(() => ({ forkMock: vi.fn() }));
vi.mock("node:child_process", () => ({ fork: forkMock }));

import {
  MAX_CONCURRENT_SPREADSHEET_PARSERS,
  spreadsheetToLLMText,
} from "../spreadsheet";

type FakeChild = EventEmitter & {
  kill: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
};

function fakeChild(): FakeChild {
  return Object.assign(new EventEmitter(), {
    kill: vi.fn(() => true),
    send: vi.fn(
      (_message: unknown, callback?: (error?: Error | null) => void) => {
        callback?.(null);
      },
    ),
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("spreadsheet parser child supervisor", () => {
  it("bounds active children, kills timed-out work, and releases slots on close", async () => {
    vi.useFakeTimers();
    vi.stubEnv("SPREADSHEET_PARSE_TIMEOUT_MS", "1000");
    const children: FakeChild[] = [];
    forkMock.mockImplementation(() => {
      const child = fakeChild();
      children.push(child);
      return child;
    });

    const first = spreadsheetToLLMText(Buffer.from("first")).then(
      () => null,
      (error: unknown) => error,
    );
    const second = spreadsheetToLLMText(Buffer.from("second")).then(
      () => null,
      (error: unknown) => error,
    );
    expect(forkMock).toHaveBeenCalledTimes(MAX_CONCURRENT_SPREADSHEET_PARSERS);
    const firstOptions = forkMock.mock.calls[0][2] as {
      serialization: string;
      execArgv: string[];
      env: NodeJS.ProcessEnv;
    };
    expect(firstOptions.serialization).toBe("advanced");
    expect(firstOptions.execArgv).toContain("--max-old-space-size=256");
    expect(Object.keys(firstOptions.env).sort()).toEqual(["NODE_ENV", "PATH"]);

    await expect(
      spreadsheetToLLMText(Buffer.from("overflow")),
    ).rejects.toMatchObject({ code: "busy" });
    expect(forkMock).toHaveBeenCalledTimes(MAX_CONCURRENT_SPREADSHEET_PARSERS);

    await vi.advanceTimersByTimeAsync(1_000);
    for (const child of children) {
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      child.emit("close", null, "SIGKILL");
    }
    await expect(first).resolves.toMatchObject({ code: "timeout" });
    await expect(second).resolves.toMatchObject({ code: "timeout" });

    const next = spreadsheetToLLMText(Buffer.from("next"));
    const finalChild = children[2];
    finalChild.emit("message", { type: "started", pid: 123 });
    finalChild.emit("message", { type: "result", text: "cell markdown" });
    finalChild.emit("close", null, "SIGKILL");
    await expect(next).resolves.toBe("cell markdown");
  });

  it("classifies a child crash and frees its capacity after reaping", async () => {
    const child = fakeChild();
    forkMock.mockReturnValueOnce(child);
    const pending = spreadsheetToLLMText(Buffer.from("bytes"));
    child.emit("close", 1, null);
    await expect(pending).rejects.toMatchObject({ code: "worker_failed" });

    const nextChild = fakeChild();
    forkMock.mockReturnValueOnce(nextChild);
    const next = spreadsheetToLLMText(Buffer.from("bytes"));
    nextChild.emit("message", { type: "result", text: "ok" });
    nextChild.emit("close", 0, null);
    await expect(next).resolves.toBe("ok");
  });

  it("distinguishes an ordinary parser rejection from a timeout", async () => {
    const child = fakeChild();
    forkMock.mockReturnValueOnce(child);
    const pending = spreadsheetToLLMText(Buffer.from("bytes"));
    child.emit("message", { type: "parse_error" });
    child.emit("close", null, "SIGKILL");
    await expect(pending).rejects.toMatchObject({ code: "parse_failed" });
  });
});
