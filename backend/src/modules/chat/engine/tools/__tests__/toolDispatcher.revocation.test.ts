import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureDocAccess: vi.fn(),
  checkProjectAccess: vi.fn(),
  checkWorkflowAccess: vi.fn(),
  readDocumentContent: vi.fn(),
  getTurnReadIdentity: vi.fn(),
  generateExcel: vi.fn(),
  generateDocx: vi.fn(),
  generatePpt: vi.fn(),
  runEditDocument: vi.fn(),
  executeMcpToolCall: vi.fn(),
  executeGoogleWorkspaceToolCall: vi.fn(),
  downloadFile: vi.fn(),
  uploadFile: vi.fn(),
}));

vi.mock("../../../../../lib/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../../lib/access")>()),
  ensureDocAccess: mocks.ensureDocAccess,
  checkProjectAccess: mocks.checkProjectAccess,
  checkWorkflowAccess: mocks.checkWorkflowAccess,
}));

vi.mock("../../../../../lib/mcpConnectors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../../lib/mcpConnectors")>()),
  executeMcpToolCall: mocks.executeMcpToolCall,
}));

vi.mock("../../../../../lib/integrations/googleWorkspace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../../lib/integrations/googleWorkspace")>()),
  executeGoogleWorkspaceToolCall: mocks.executeGoogleWorkspaceToolCall,
}));

vi.mock("../../../../../lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../../lib/storage")>()),
  downloadFile: mocks.downloadFile,
  uploadFile: mocks.uploadFile,
}));

vi.mock("../documentOps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../documentOps")>()),
  readDocumentContent: mocks.readDocumentContent,
  getTurnReadIdentity: mocks.getTurnReadIdentity,
  generateExcel: mocks.generateExcel,
  generateDocx: mocks.generateDocx,
  generatePpt: mocks.generatePpt,
  runEditDocument: mocks.runEditDocument,
}));

import { runToolCalls } from "../toolDispatcher";
import type { DocIndex, DocStore, WorkflowStore } from "../../types";

const documentRow = {
  id: "document-1",
  user_id: "owner-1",
  project_id: "project-1",
  org_id: null,
  workflow_id: null,
};

function database(currentDocument: typeof documentRow | null = documentRow) {
  const queries: Array<{ table: string }> = [];
  class Query {
    constructor(private readonly table: string) {
      queries.push({ table });
    }
    select() { return this; }
    eq() { return this; }
    maybeSingle() {
      return Promise.resolve({
        data: this.table === "documents" ? currentDocument : null,
        error: null,
      });
    }
    single() { return this.maybeSingle(); }
    then(resolve: (value: { data: unknown; error: null }) => unknown) {
      return this.maybeSingle().then(resolve);
    }
  }
  return { from: vi.fn((table: string) => new Query(table)), queries };
}

const docStore: DocStore = new Map([
  ["doc-0", { storage_path: "documents/private.pdf", file_type: "pdf", filename: "private.pdf" }],
]);
const docIndex: DocIndex = {
  "doc-0": { document_id: "document-1", filename: "private.pdf", version_id: "version-1" },
};

function tool(name: string, args: Record<string, unknown>) {
  return { id: "call-1", function: { name, arguments: JSON.stringify(args) } };
}

describe("tool dispatch revalidates captured authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureDocAccess.mockResolvedValue({ ok: false });
    mocks.checkProjectAccess.mockResolvedValue({ ok: false });
    mocks.checkWorkflowAccess.mockResolvedValue({ ok: false });
    mocks.getTurnReadIdentity.mockResolvedValue({
      key: "doc-0:documents/private.pdf",
      docLabel: "doc-0",
      filename: "private.pdf",
      documentId: "document-1",
      versionId: "version-1",
      versionNumber: 1,
      storagePath: "documents/private.pdf",
    });
    mocks.readDocumentContent.mockResolvedValue("confidential source text");
  mocks.generateExcel.mockResolvedValue({ error: "should not run" });
  mocks.downloadFile.mockResolvedValue(new TextEncoder().encode("source").buffer);
  mocks.uploadFile.mockResolvedValue(undefined);
  });

  it("does not read a document through a captured store after access is revoked", async () => {
    const db = database();
    const result = await runToolCalls(
      [tool("read_document", { doc_id: "doc-0" })],
      docStore,
      "user-1",
      db as never,
      () => undefined,
      undefined,
      undefined,
      docIndex,
      undefined,
      undefined,
      "project-1",
      undefined,
      undefined,
      "nonce",
      undefined,
      "user@example.com",
    );

    expect(mocks.checkProjectAccess).toHaveBeenCalledWith(
      "project-1",
      "user-1",
      "user@example.com",
      db,
    );
    expect(mocks.readDocumentContent).not.toHaveBeenCalled();
    expect(mocks.downloadFile).not.toHaveBeenCalled();
    expect(JSON.stringify(result.toolResults)).not.toContain("confidential source text");
  });

  it("does not read a stale storage object after its document row is deleted", async () => {
    const db = database(null);
    const result = await runToolCalls(
      [tool("read_document", { doc_id: "doc-0" })],
      docStore,
      "user-1",
      db as never,
      () => undefined,
      undefined,
      undefined,
      docIndex,
    );

    expect(mocks.readDocumentContent).not.toHaveBeenCalled();
    expect(mocks.downloadFile).not.toHaveBeenCalled();
    expect(JSON.stringify(result.toolResults)).not.toContain(
      "confidential source text",
    );
  });

  it("does not return a captured workflow prompt after its share is revoked", async () => {
    const workflowStore: WorkflowStore = new Map([
      ["workflow-1", { title: "Privileged workflow", skill_md: "confidential workflow prompt", listed: true }],
    ]);
    const result = await runToolCalls(
      [tool("read_workflow", { workflow_id: "workflow-1" })],
      new Map(),
      "user-1",
      database() as never,
      () => undefined,
      workflowStore,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "nonce",
      undefined,
      "user@example.com",
    );

    expect(mocks.checkWorkflowAccess).toHaveBeenCalledWith(
      "workflow-1",
      "user-1",
      "user@example.com",
      expect.anything(),
    );
    expect(JSON.stringify(result.toolResults)).not.toContain("confidential workflow prompt");
    expect(result.workflowsApplied).toEqual([]);
  });

  it("does not generate into a project after the captured editor grant is revoked", async () => {
    const db = database();
    const result = await runToolCalls(
      [tool("generate_excel", { title: "New matter workbook", sheets: [] })],
      new Map(),
      "user-1",
      db as never,
      () => undefined,
      undefined,
      undefined,
      {},
      undefined,
      undefined,
      "project-1",
      undefined,
      undefined,
      "nonce",
      undefined,
      "user@example.com",
    );

    expect(mocks.checkProjectAccess).toHaveBeenCalledWith(
      "project-1",
      "user-1",
      "user@example.com",
      db,
    );
    expect(mocks.generateExcel).not.toHaveBeenCalled();
    expect(result.docsCreated).toEqual([]);
  });

  it("does not read a source for replicate_document after the grant is revoked", async () => {
    mocks.ensureDocAccess
      .mockResolvedValueOnce({ ok: true, projectRole: "editor" })
      .mockResolvedValueOnce({ ok: false });
    const db = database();
    const result = await runToolCalls(
      [tool("replicate_document", { doc_id: "doc-0", new_filename: "Copy.pdf" })],
      docStore,
      "user-1",
      db as never,
      () => undefined,
      undefined,
      undefined,
      docIndex,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "nonce",
      undefined,
      "user@example.com",
    );

    expect(mocks.ensureDocAccess).toHaveBeenCalledTimes(2);
    expect(mocks.downloadFile).not.toHaveBeenCalled();
    expect(mocks.uploadFile).not.toHaveBeenCalled();
    expect(JSON.stringify(result.toolResults)).toContain(
      "This resource is no longer available.",
    );
  });

  it("does not read or copy a source when destination edit access is revoked", async () => {
    mocks.ensureDocAccess.mockResolvedValue({ ok: true, projectRole: "editor" });
    mocks.checkProjectAccess
      .mockResolvedValueOnce({ ok: true, projectRole: "editor" })
      .mockResolvedValueOnce({ ok: false });
    const db = database();
    const result = await runToolCalls(
      [tool("replicate_document", { doc_id: "doc-0", new_filename: "Copy.pdf" })],
      docStore,
      "user-1",
      db as never,
      () => undefined,
      undefined,
      undefined,
      docIndex,
      undefined,
      undefined,
      "destination-project",
      undefined,
      undefined,
      "nonce",
      undefined,
      "user@example.com",
    );

    expect(mocks.downloadFile).not.toHaveBeenCalled();
    expect(mocks.uploadFile).not.toHaveBeenCalled();
    expect(JSON.stringify(result.toolResults)).toContain(
      "This resource is no longer available.",
    );
  });

  it("does not invoke edit_document against a revoked document", async () => {
    const docxStore: DocStore = new Map([
      ["doc-0", { storage_path: "documents/private.docx", file_type: "docx", filename: "private.docx" }],
    ]);
    const result = await runToolCalls(
      [tool("edit_document", { doc_id: "doc-0", edits: [{ find: "old", replace: "new" }] })],
      docxStore,
      "user-1",
      database() as never,
      () => undefined,
      undefined,
      undefined,
      docIndex,
      undefined,
      undefined,
      "project-1",
      undefined,
      undefined,
      "nonce",
      undefined,
      "user@example.com",
    );

    expect(mocks.runEditDocument).not.toHaveBeenCalled();
    expect(mocks.uploadFile).not.toHaveBeenCalled();
    expect(result.docsEdited).toEqual([]);
  });

  it("keeps an authorized project read and generation available", async () => {
    mocks.ensureDocAccess.mockResolvedValue({ ok: true, projectRole: "editor" });
    mocks.checkProjectAccess.mockResolvedValue({ ok: true, projectRole: "editor" });
    mocks.generateExcel.mockResolvedValue({
      filename: "Workbook.xlsx",
      download_url: "/download/token",
      document_id: "created-1",
      version_id: "version-2",
      version_number: 1,
      storage_path: "documents/generated.xlsx",
    });
    const db = database();
    const result = await runToolCalls(
      [tool("generate_excel", { title: "Workbook", sheets: [] })],
      new Map(),
      "user-1",
      db as never,
      () => undefined,
      undefined,
      undefined,
      {},
      undefined,
      undefined,
      "project-1",
      undefined,
      undefined,
      "nonce",
      undefined,
      "user@example.com",
    );

    expect(mocks.generateExcel).toHaveBeenCalledOnce();
    expect(result.docsCreated).toHaveLength(1);
  });

  it("does not dispatch an external action using a revoked captured document context", async () => {
    const db = database();
    const result = await runToolCalls(
      [tool("mcp_case_lookup", { query: "confidential matter detail" })],
      docStore,
      "user-1",
      db as never,
      () => undefined,
      undefined,
      undefined,
      docIndex,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "nonce",
      undefined,
      "user@example.com",
    );

    expect(mocks.ensureDocAccess).toHaveBeenCalledWith(
      documentRow,
      "user-1",
      "user@example.com",
      db,
    );
    expect(mocks.executeMcpToolCall).not.toHaveBeenCalled();
    expect(JSON.stringify(result.toolResults)).toContain(
      "This resource is no longer available.",
    );
  });

  it("does not dispatch a Google action using a revoked captured document context", async () => {
    const db = database();
    const result = await runToolCalls(
      [tool("gmail_search_messages", { query: "confidential matter detail" })],
      docStore,
      "user-1",
      db as never,
      () => undefined,
      undefined,
      undefined,
      docIndex,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "nonce",
      undefined,
      "user@example.com",
    );

    expect(mocks.ensureDocAccess).toHaveBeenCalledWith(
      documentRow,
      "user-1",
      "user@example.com",
      db,
    );
    expect(mocks.executeGoogleWorkspaceToolCall).not.toHaveBeenCalled();
    expect(JSON.stringify(result.toolResults)).toContain(
      "This resource is no longer available.",
    );
  });

  it("preserves an authorized Google action dispatch", async () => {
    mocks.ensureDocAccess.mockResolvedValue({ ok: true, projectRole: "editor" });
    mocks.executeGoogleWorkspaceToolCall.mockResolvedValue({
      content: JSON.stringify({ ok: true, data: { messages: [] } }),
      event: {
        type: "mcp_tool_call",
        connector_id: "gmail-native",
        connector_name: "Gmail",
        tool_name: "gmail_search_messages",
        openai_tool_name: "gmail_search_messages",
        status: "ok",
      },
    });
    const result = await runToolCalls(
      [tool("gmail_search_messages", { query: "matter status" })],
      docStore,
      "user-1",
      database() as never,
      () => undefined,
      undefined,
      undefined,
      docIndex,
    );

    expect(mocks.executeGoogleWorkspaceToolCall).toHaveBeenCalledOnce();
    expect(result.mcpEvents).toHaveLength(1);
  });
});
