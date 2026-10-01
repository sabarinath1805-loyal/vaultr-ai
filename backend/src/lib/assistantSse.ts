import { type Response } from "express";
import { streamCapacityConfiguration } from "./runtimeConfig";

export function openAssistantSse(
  res: Response,
  limits: { maxDurationMs: number; idleTimeoutMs: number } =
    streamCapacityConfiguration(),
): {
  signal: AbortSignal;
  write: (line: string) => boolean;
  finish: () => void;
} {
  return openAssistantSseWithLimits(res, limits);
}

export function openAssistantSseWithLimits(
  res: Response,
  limits: { maxDurationMs: number; idleTimeoutMs: number },
): {
  signal: AbortSignal;
  write: (line: string) => boolean;
  finish: () => void;
} {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const controller = new AbortController();
  let finished = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  const clearTimers = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (totalTimer) clearTimeout(totalTimer);
    idleTimer = undefined;
    totalTimer = undefined;
  };
  const endForTimeout = () => {
    if (finished) return;
    finished = true;
    clearTimers();
    controller.abort(new Error("assistant stream deadline exceeded"));
    try {
      if (!res.writableEnded && !res.destroyed) {
        res.write(
          `data: ${JSON.stringify({
            type: "error",
            code: "stream_timeout",
            message: "The response timed out. Please try again.",
          })}\n\ndata: [DONE]\n\n`,
        );
        res.end();
      }
    } catch {
      // A disconnected peer already ended the only response channel.
    }
  };
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(endForTimeout, limits.idleTimeoutMs);
    idleTimer.unref?.();
  };
  const onClose = () => {
    if (finished) return;
    finished = true;
    clearTimers();
    controller.abort(new Error("assistant stream client disconnected"));
  };
  res.once("close", onClose);
  res.once("finish", () => {
    if (finished) return;
    finished = true;
    clearTimers();
    controller.abort(new Error("assistant stream response finished"));
  });
  totalTimer = setTimeout(endForTimeout, limits.maxDurationMs);
  totalTimer.unref?.();
  resetIdleTimer();

  return {
    signal: controller.signal,
    // A producer can lose the race against finish(): an error handler that
    // fires after the happy path already ended the response would call
    // res.write() on an ended stream, raising an asynchronous
    // ERR_STREAM_WRITE_AFTER_END that no try/catch around the write can see.
    // Dropping the late line is correct — the response is over either way.
    write: (line) => {
      if (finished || res.writableEnded) return false;
      resetIdleTimer();
      return res.write(line);
    },
    finish: () => {
      if (finished) return;
      finished = true;
      clearTimers();
      res.end();
    },
  };
}
