import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    attachActiveVersionPaths: vi.fn(),
    downloadFile: vi.fn(),
    extractDocumentMarkdown: vi.fn(),
}));

vi.mock("../../../lib/documentVersions", () => ({
    attachActiveVersionPaths: mocks.attachActiveVersionPaths,
}));
vi.mock("../../../lib/storage", () => ({
    downloadFile: mocks.downloadFile,
}));
vi.mock("../tabular.extract", () => ({
    extractDocumentMarkdown: mocks.extractDocumentMarkdown,
}));

import { loadRowDocumentText } from "../tabular.rows";
import type { ReviewRow, SourceDocument } from "../tabular.rows";

const row: ReviewRow = {
    id: "row-1",
    review_id: "review-1",
    label: "Contract.pdf",
    row_type: "document",
    folder_id: null,
    library_folder_id: null,
    document_id: "document-1",
    sort_index: 0,
    source_document_ids: ["document-1"],
};

function makeDb(events: string[]) {
    const query = {
        select: vi.fn(() => query),
        in: vi.fn(() => query),
        then: (resolve: (value: unknown) => unknown) => {
            events.push("database:documents");
            return Promise.resolve({
                data: [
                    {
                        id: "document-1",
                        filename: "Confidential contract.pdf",
                        file_type: "pdf",
                        user_id: "owner-1",
                        project_id: "project-1",
                        current_version_id: "version-1",
                    },
                ],
                error: null,
            }).then(resolve);
        },
    };
    return { from: vi.fn(() => query) };
}

describe("Tabular Review source authorization", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.attachActiveVersionPaths.mockImplementation(
            async (_db: unknown, docs: Record<string, unknown>[]) => {
                for (const doc of docs) doc.storage_path = null;
                return docs;
            },
        );
        mocks.downloadFile.mockResolvedValue(null);
        mocks.extractDocumentMarkdown.mockResolvedValue("");
    });

    it("checks current source access before loading document metadata, even without an active version", async () => {
        const events: string[] = [];
        const db = makeDb(events);
        const authorizeDocument = vi.fn(
            async (document: string | SourceDocument) => {
                const id = typeof document === "string" ? document : document.id;
                events.push(`authorize:${id}`);
                throw new Error("access revoked");
            },
        );

        await expect(
            loadRowDocumentText(db as never, row, { authorizeDocument }),
        ).rejects.toThrow("access revoked");

        expect(events).toEqual(["authorize:document-1"]);
        expect(db.from).not.toHaveBeenCalled();
        expect(mocks.attachActiveVersionPaths).not.toHaveBeenCalled();
        expect(mocks.downloadFile).not.toHaveBeenCalled();
    });

    it("rechecks access before returning source metadata when no active version exists", async () => {
        const events: string[] = [];
        const db = makeDb(events);
        const authorizeDocument = vi.fn(
            async (document: string | SourceDocument) => {
                const id = typeof document === "string" ? document : document.id;
                events.push(`authorize:${id}`);
            },
        );

        const text = await loadRowDocumentText(db as never, row, {
            authorizeDocument,
        });

        expect(events).toEqual([
            "authorize:document-1",
            "database:documents",
            "authorize:document-1",
        ]);
        expect(text).toContain("Confidential contract.pdf");
        expect(mocks.downloadFile).not.toHaveBeenCalled();
    });
});
