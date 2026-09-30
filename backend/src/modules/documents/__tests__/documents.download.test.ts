import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../lib/supabase";

const mocks = vi.hoisted(() => ({
  ensureDocumentAccess: vi.fn(),
  loadActiveVersion: vi.fn(),
  getSignedUrl: vi.fn(),
}));

vi.mock("../documents.access", () => ({
  ensureDocumentAccess: mocks.ensureDocumentAccess,
}));
vi.mock("../../../lib/documentVersions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/documentVersions")>()),
  loadActiveVersion: mocks.loadActiveVersion,
}));
vi.mock("../../../lib/storage", () => ({
  getSignedUrl: mocks.getSignedUrl,
  headFile: vi.fn(),
  SIGNED_DOCUMENT_GET_TTL_SECONDS: 900,
}));

import {
  collectFolderDescendantIds,
  getDownloadUrl,
} from "../documents.download";
import { SIGNED_DOCUMENT_GET_TTL_SECONDS } from "../../../lib/storage";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.ensureDocumentAccess.mockResolvedValue({ ok: true });
  mocks.loadActiveVersion.mockResolvedValue({
    id: "version-1",
    storage_path: "documents/u1/d1/v1.docx",
    pdf_storage_path: null,
    version_number: 1,
    filename: "Agreement.docx",
    source: "user_upload",
    file_type: "docx",
  });
  mocks.getSignedUrl.mockResolvedValue("https://storage.example.test/signed");
});

describe("collectFolderDescendantIds", () => {
  it("includes every nested descendant and excludes unrelated folders", () => {
    const ids = collectFolderDescendantIds(
      [{ id: "folder-root" }],
      [
        { id: "folder-root", parent_folder_id: null },
        { id: "folder-child", parent_folder_id: "folder-root" },
        { id: "folder-grandchild", parent_folder_id: "folder-child" },
        { id: "folder-unrelated", parent_folder_id: null },
      ],
    );

    expect(ids).toEqual([
      "folder-root",
      "folder-child",
      "folder-grandchild",
    ]);
  });
});

describe("signed document URL renewal", () => {
  it("uses the short document GET TTL after checking current access", async () => {
    const result = await getDownloadUrl(
      "document-1",
      "user-1",
      "user@example.test",
      null,
      {} as Db,
    );

    expect(result).toMatchObject({ ok: true });
    expect(mocks.ensureDocumentAccess).toHaveBeenCalledWith(
      "document-1",
      "user-1",
      "user@example.test",
      expect.anything(),
    );
    expect(mocks.getSignedUrl).toHaveBeenCalledWith(
      "documents/u1/d1/v1.docx",
      SIGNED_DOCUMENT_GET_TTL_SECONDS,
      expect.stringContaining("Agreement"),
    );
  });

  it("does not renew a URL after access has been revoked", async () => {
    mocks.ensureDocumentAccess.mockResolvedValue({ ok: false });

    await expect(
      getDownloadUrl(
        "document-1",
        "user-1",
        "user@example.test",
        null,
        {} as Db,
      ),
    ).resolves.toMatchObject({ ok: false, kind: "not_found" });

    expect(mocks.loadActiveVersion).not.toHaveBeenCalled();
    expect(mocks.getSignedUrl).not.toHaveBeenCalled();
  });
});
