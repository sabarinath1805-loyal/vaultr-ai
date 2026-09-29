import { beforeEach, describe, expect, it, vi } from "vitest";

type ProviderCall = {
  callbacks?: { onContentDelta?: (delta: string) => void };
  runTools?: (
    calls: { id: string; name: string; input: Record<string, unknown> }[],
  ) => Promise<unknown>;
};

const mocks = vi.hoisted(() => ({
  streamChatWithTools: vi.fn(async (_params: ProviderCall) => ({
    fullText: "",
  })),
  authorizeCurrentTurnContext: vi.fn(async (..._args: unknown[]) => true),
  runToolCalls: vi.fn(async (..._args: unknown[]) => ({
    toolResults: [{ tool_call_id: "call-1", content: "confidential source result" }],
    docsRead: [],
    docsFound: [],
    docsCreated: [],
    docsReplicated: [],
    workflowsApplied: [],
    docsEdited: [],
    askInputsEvents: [],
    courtlistenerEvents: [],
    caseCitationEvents: [],
    mcpEvents: [],
  })),
}));

vi.mock("../../../../lib/llm", async () => ({
  ...(await vi.importActual<Record<string, unknown>>(
    "../../../../lib/llm/models",
  )),
  streamChatWithTools: (params: ProviderCall) =>
    mocks.streamChatWithTools(params),
}));

vi.mock("../../../../lib/mcpConnectors", () => ({
  buildUserMcpTools: vi.fn(async () => []),
}));

vi.mock("../tools/toolDispatcher", () => ({
  authorizeCurrentTurnContext: (...args: unknown[]) =>
    mocks.authorizeCurrentTurnContext(...args),
  runToolCalls: (...args: unknown[]) => mocks.runToolCalls(...args),
}));

import { AssistantStreamError, runLLMStream } from "../streaming";

function visibleText(chunks: string[]): string {
  return chunks
    .flatMap((chunk) => chunk.split("\n\n"))
    .filter((frame) => frame.startsWith("data: "))
    .map((frame) => {
      try {
        return JSON.parse(frame.slice(6)) as { type?: string; text?: string };
      } catch {
        return {};
      }
    })
    .filter((event) => event.type === "content_delta")
    .map((event) => event.text ?? "")
    .join("");
}

function params(write: (chunk: string) => void) {
  return {
    model: "gemini-3-flash-preview",
    apiMessages: [{ role: "user", content: "Summarize this matter." }],
    docStore: new Map(),
    docIndex: {},
    userId: "user-1",
    userEmail: "user@example.com",
    db: {} as never,
    write,
    projectId: "project-1",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeCurrentTurnContext.mockResolvedValue(true);
  mocks.streamChatWithTools.mockResolvedValue({ fullText: "" });
  mocks.runToolCalls.mockResolvedValue({
    toolResults: [{ tool_call_id: "call-1", content: "confidential source result" }],
    docsRead: [],
    docsFound: [],
    docsCreated: [],
    docsReplicated: [],
    workflowsApplied: [],
    docsEdited: [],
    askInputsEvents: [],
    courtlistenerEvents: [],
    caseCitationEvents: [],
    mcpEvents: [],
  });
});

describe("protected assistant stream revocation", () => {
  it("withholds answer deltas when access is revoked before the final stream boundary", async () => {
    const chunks: string[] = [];
    mocks.authorizeCurrentTurnContext
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    mocks.streamChatWithTools.mockImplementationOnce(async ({ callbacks }) => {
      callbacks?.onContentDelta?.("confidential answer from project context");
      return { fullText: "confidential answer from project context" };
    });

    let error: unknown;
    try {
      await runLLMStream(params((chunk) => chunks.push(chunk)));
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AssistantStreamError);
    expect((error as AssistantStreamError).fullText).toBe("");
    expect(visibleText(chunks)).toBe("");
    expect((error as AssistantStreamError).events).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: "This conversation is no longer available.",
      }),
    );
  });

  it("releases the answer when current access remains authorized", async () => {
    const chunks: string[] = [];
    mocks.streamChatWithTools.mockImplementationOnce(async ({ callbacks }) => {
      callbacks?.onContentDelta?.("authorized project answer");
      return { fullText: "authorized project answer" };
    });

    const result = await runLLMStream(params((chunk) => chunks.push(chunk)));

    expect(result.fullText).toBe("authorized project answer");
    expect(visibleText(chunks)).toBe("authorized project answer");
    expect(mocks.authorizeCurrentTurnContext).toHaveBeenCalledTimes(2);
  });

  it("does not return tool results to the provider after access changes during dispatch", async () => {
    const chunks: string[] = [];
    let providerContinuedWithToolResults = false;
    mocks.authorizeCurrentTurnContext
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    mocks.streamChatWithTools.mockImplementationOnce(async ({ runTools }) => {
      const toolResults = await runTools?.([
        {
          id: "call-1",
          name: "read_document",
          input: { doc_id: "doc-1" },
        },
      ]);
      providerContinuedWithToolResults = toolResults !== undefined;
      return { fullText: "next model round" };
    });

    await expect(
      runLLMStream(params((chunk) => chunks.push(chunk))),
    ).rejects.toBeInstanceOf(AssistantStreamError);

    expect(mocks.runToolCalls).toHaveBeenCalledOnce();
    expect(providerContinuedWithToolResults).toBe(false);
    expect(chunks.join("")).not.toContain("confidential source result");
  });
});
