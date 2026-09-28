import { spreadsheetToLLMTextSync } from "./spreadsheetParser";

type ParseRequest = { buffer?: unknown };

function send(
  message: { type: "result"; text: string } | { type: "parse_error" },
) {
  if (!process.send) return;
  process.send(message, () => process.disconnect?.());
}

process.once("message", (message: ParseRequest) => {
  const input = message?.buffer;
  if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) {
    send({ type: "parse_error" });
    return;
  }

  // The parent uses this handshake to coordinate bounded runtime probes.
  process.send?.({ type: "started", pid: process.pid });
  try {
    const text = spreadsheetToLLMTextSync(Buffer.from(input));
    send({ type: "result", text });
  } catch {
    // Raw parser exceptions can contain implementation details. Send only a
    // status; the parent maps this to a safe application error.
    send({ type: "parse_error" });
  }
});
