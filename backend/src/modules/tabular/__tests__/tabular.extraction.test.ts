import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  currentAuthUserEmail: vi.fn(),
  ensureReviewAccess: vi.fn(),
  extractRowColumns: vi.fn(),
  finishGenerationIfIdle: vi.fn(),
  loadReviewRow: vi.fn(),
  renewGeneration: vi.fn(),
  validateSelectedModel: vi.fn(),
}));

vi.mock("../../../lib/userLookup", () => ({
  currentAuthUserEmail: mocks.currentAuthUserEmail,
}));

vi.mock("../../../lib/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/access")>()),
  ensureReviewAccess: mocks.ensureReviewAccess,
}));

vi.mock("../tabular.service", () => ({
  extractRowColumns: mocks.extractRowColumns,
  finishGenerationIfIdle: mocks.finishGenerationIfIdle,
  loadReviewRow: mocks.loadReviewRow,
  renewGeneration: mocks.renewGeneration,
  TABULAR_GENERATION_HEARTBEAT_MS: 60_000,
  validateSelectedModel: mocks.validateSelectedModel,
}));

import { runExtractionJob } from "../tabular.extraction";

const review = {
  id: "review-1",
  user_id: "owner-1",
  project_id: "project-1",
  org_id: null,
  columns_config: [{ index: 0, name: "Clause" }],
  model: "provider/model",
};

function database() {
  const tables: string[] = [];
  class Query {
    constructor(private readonly table: string) {
      tables.push(table);
    }
    select() {
      return this;
    }
    update() {
      return this;
    }
    eq() {
      return this;
    }
    maybeSingle() {
      return Promise.resolve({
        data: this.table === "tabular_reviews" ? review : null,
        error: null,
      });
    }
    single() {
      return this.maybeSingle();
    }
    then(resolve: (value: { data: unknown; error: null }) => unknown) {
      return Promise.resolve({
        data: this.table === "tabular_cells" ? [] : null,
        error: null,
      }).then(resolve);
    }
  }
  return { from: vi.fn((table: string) => new Query(table)), tables };
}

const job = {
  reviewId: "review-1",
  userId: "user-1",
  rowId: "row-1",
  generationId: "generation-1",
};

describe("queued tabular extraction authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentAuthUserEmail.mockResolvedValue("user@example.com");
    mocks.ensureReviewAccess.mockResolvedValue({ ok: false });
    mocks.loadReviewRow.mockResolvedValue({
      id: "row-1",
      review_id: "review-1",
      label: "Contract.pdf",
      row_type: "document",
      folder_id: null,
      library_folder_id: null,
      document_id: "document-1",
      sort_index: 0,
      source_document_ids: ["document-1"],
    });
    mocks.validateSelectedModel.mockResolvedValue({
      ok: true,
      model: "provider/model",
      apiKeys: {},
    });
    mocks.extractRowColumns.mockResolvedValue({
      processed: [],
      missing: [],
      received: new Set(),
    });
    mocks.finishGenerationIfIdle.mockResolvedValue(undefined);
  });

  it("fails a queued attempt closed before review, source, provider, or cell work after revoke", async () => {
    const db = database();
    const publish = vi.fn(async () => undefined);

    await runExtractionJob(job, { db: db as never, publish });
    await runExtractionJob(job, { db: db as never, publish });

    expect(mocks.ensureReviewAccess).toHaveBeenCalledTimes(2);
    expect(mocks.loadReviewRow).not.toHaveBeenCalled();
    expect(mocks.validateSelectedModel).not.toHaveBeenCalled();
    expect(mocks.extractRowColumns).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(db.tables).toEqual([
      "tabular_reviews",
      "tabular_cells",
      "tabular_reviews",
      "tabular_cells",
    ]);
  });

  it("continues an authorized queued extraction through the worker boundary", async () => {
    mocks.ensureReviewAccess.mockResolvedValue({
      ok: true,
      projectRole: "editor",
    });
    const db = database();

    await runExtractionJob(job, {
      db: db as never,
      publish: vi.fn(async () => undefined),
    });

    expect(mocks.loadReviewRow).toHaveBeenCalledWith(db, "review-1", "row-1");
    expect(mocks.validateSelectedModel).toHaveBeenCalledWith(
      "provider/model",
      "user-1",
      db,
    );
    expect(mocks.extractRowColumns).toHaveBeenCalledOnce();
    expect(db.tables).toContain("tabular_cells");
  });
});
