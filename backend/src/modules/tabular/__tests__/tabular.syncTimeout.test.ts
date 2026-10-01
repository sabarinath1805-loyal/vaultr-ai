import { afterEach, describe, expect, it, vi } from "vitest";

const { extractRowColumnsMock, finalizeCellMock } = vi.hoisted(() => ({
  extractRowColumnsMock: vi.fn(),
  finalizeCellMock: vi.fn(),
}));

vi.mock("../tabular.extractRow", () => ({
  extractRowColumns: extractRowColumnsMock,
  finalizeCell: finalizeCellMock,
}));

import { streamTabularGenerateSync } from "../tabular.generateStream";

describe("synchronous Tabular stream deadlines", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.LLM_STREAM_IDLE_TIMEOUT_MS;
    delete process.env.LLM_STREAM_MAX_DURATION_MS;
    extractRowColumnsMock.mockReset();
    finalizeCellMock.mockReset();
  });

  it("aborts extraction and ends the response at the idle deadline", async () => {
    vi.useFakeTimers();
    process.env.LLM_STREAM_IDLE_TIMEOUT_MS = "10000";
    process.env.LLM_STREAM_MAX_DURATION_MS = "30000";
    const response = {
      destroyed: false,
      writableEnded: false,
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn(() => true),
      end: vi.fn(() => { response.writableEnded = true; }),
    };
    const controller = new AbortController();
    extractRowColumnsMock.mockImplementation(
      ({ abortSignal }: { abortSignal: AbortSignal }) =>
        new Promise((resolve) => {
          abortSignal.addEventListener(
            "abort",
            () => resolve({ missing: [], error: undefined }),
            { once: true },
          );
        }),
    );
    const onTimeout = vi.fn(() => controller.abort());

    const running = streamTabularGenerateSync({
      res: response as never,
      db: {} as never,
      reviewId: "review-id",
      columns: [{ index: 0, name: "Summary", prompt: "Summarize" }],
      rows: [{ id: "row-id" }] as never,
      cellMap: new Map(),
      model: "local-test-model",
      apiKeys: {} as never,
      generationId: "generation-id",
      abortSignal: controller.signal,
      onTimeout,
    });

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(running).resolves.toBe(false);

    expect(onTimeout).toHaveBeenCalledOnce();
    expect(controller.signal.aborted).toBe(true);
    expect(response.write).toHaveBeenCalledWith(
      expect.stringContaining('"code":"stream_timeout"'),
    );
    expect(response.end).toHaveBeenCalledOnce();
  });
});
