import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type { Db } from "../../supabase";
import type {
    EnqueueDbJobInput,
    EnqueueDbJobResult,
} from "../../dbq/enqueue";

// These suites pin the REDIS driver's BullMQ semantics; the Postgres-driver
// routing (same identities, DB queue transport) is pinned separately below.
process.env.QUEUE_DRIVER = "redis";
afterAll(() => {
    delete process.env.QUEUE_DRIVER;
});

// Both stubs carry the signature of what they replace, so the recorded calls
// below are real argument tuples instead of untyped rest arrays.
const enqueueDbJob = vi.fn<
    (db: Db, input: EnqueueDbJobInput) => Promise<EnqueueDbJobResult>
>(async () => ({ id: "dbjob-1", deduped: false }));
vi.mock("../../dbq/enqueue", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../dbq/enqueue")>();
    return {
        ...actual,
        enqueueDbJob: (db: Db, input: EnqueueDbJobInput) =>
            enqueueDbJob(db, input),
    };
});
vi.mock("../../supabase", () => ({ createServerSupabase: () => ({}) }));
const rpc = vi.fn<
    (
        fn: string,
        params: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: { message: string } | null }>
>(async () => ({ data: 0, error: null }));
vi.mock("../../supabase", () => ({
    createServerSupabase: () => ({
        rpc: (fn: string, params: Record<string, unknown>) => rpc(fn, params),
    }),
}));

// One stable object per mock: the real getter returns the SAME instance
// until a wedge replaces it, and the queue getters rebuild on identity
// change — a fresh {} per call would look like a replacement every time.
const fakeProducerConnection = {};
vi.mock("../connection", () => ({
    getRedisConnection: () => ({}),
    getRedisProducerConnection: () => fakeProducerConnection,
    withRedisTimeout: <T,>(_label: string, run: () => Promise<T>) => run(),
}));

const add = vi.fn();
vi.mock("bullmq", () => ({
    Queue: class {
        add = add;
    },
}));

import {
    conversionJobId,
    enqueueConversion,
    type ConversionJobData,
} from "../conversionQueue";

const DATA: ConversionJobData = {
    documentId: "doc-1",
    versionId: "ver-1",
    userId: "user-1",
    storagePath: "uploads/user-1/doc-1.docx",
    fileType: "docx",
};

beforeEach(() => {
    add.mockReset();
    enqueueDbJob.mockClear();
});

describe("conversionJobId", () => {
    it("is deterministic on (versionId, storagePath)", () => {
        expect(conversionJobId("ver-1", DATA.storagePath)).toBe(
            conversionJobId("ver-1", DATA.storagePath),
        );
        expect(conversionJobId("ver-1", DATA.storagePath)).toMatch(
            /^convert_ver-1_[0-9a-f]{12}$/,
        );
    });

    // Replace-file reuses the versionId but always mints a NEW storage key.
    // A version-only id therefore collapses the second replace into the job
    // still carrying the first upload's key: the enqueue reports success and
    // the new bytes are never converted.
    it("gives a re-uploaded file its own id so a re-replace is not deduped away", () => {
        expect(conversionJobId("ver-1", "uploads/user-1/aaa.docx")).not.toBe(
            conversionJobId("ver-1", "uploads/user-1/bbb.docx"),
        );
    });

    it("keeps colons out of the id (BullMQ reserves them)", () => {
        expect(conversionJobId("ver-1", DATA.storagePath)).not.toContain(":");
    });
});

describe("enqueueConversion", () => {
    it("uses the durable queue with the (version, storage key) identity", async () => {
        await enqueueConversion(DATA);

        expect(add).not.toHaveBeenCalled();
        expect(enqueueDbJob).toHaveBeenCalledTimes(1);
        const [, input] = enqueueDbJob.mock.calls[0];
        expect(input.kind).toBe("conversion.convert");
        expect(input.payload).toEqual(DATA);
        expect(input.dedupeKey).toBe(
            conversionJobId(DATA.versionId, DATA.storagePath),
        );
        expect(input.maxAttempts).toBe(3);
    });

    it("does not dedupe a second replace of the same version", async () => {
        await enqueueConversion(DATA);
        await enqueueConversion({
            ...DATA,
            storagePath: "uploads/user-1/doc-1-replaced.docx",
        });

        expect(enqueueDbJob).toHaveBeenCalledTimes(2);
        expect(enqueueDbJob.mock.calls[0][1].dedupeKey).not.toBe(
            enqueueDbJob.mock.calls[1][1].dedupeKey,
        );
    });

    it("keeps the same retry budget in the durable queue", async () => {
        await enqueueConversion(DATA);
        const input = enqueueDbJob.mock.calls[0][1];
        expect(input.maxAttempts).toBe(3);
    });

    it("carries the version-flow fields (pdfKey, finalizeDocumentStatus) through", async () => {
        await enqueueConversion({
            ...DATA,
            pdfKey: "converted-pdfs/user-1/doc-1/slug.pdf",
            finalizeDocumentStatus: false,
        });

        const data = enqueueDbJob.mock.calls[0][1].payload;
        expect(data.pdfKey).toBe("converted-pdfs/user-1/doc-1/slug.pdf");
        expect(data.finalizeDocumentStatus).toBe(false);
    });
});

describe("enqueueConversion (postgres driver)", () => {
    it("routes to the DB queue with the same dedupe identity and retry budget", async () => {
        process.env.QUEUE_DRIVER = "postgres";
        try {
            enqueueDbJob.mockClear();
            await enqueueConversion({
                documentId: "doc-1",
                versionId: "ver-1",
                userId: "user-1",
                storagePath: "documents/user-1/doc-1/source.docx",
                fileType: "docx",
            });
            expect(enqueueDbJob).toHaveBeenCalledTimes(1);
            const [, input] = enqueueDbJob.mock.calls[0];
            expect(input.kind).toBe("conversion.convert");
            // The BullMQ jobId doubles as the DB dedupe key, so double
            // submits collapse identically on either transport.
            expect(input.dedupeKey).toBe(
                conversionJobId("ver-1", "documents/user-1/doc-1/source.docx"),
            );
            expect(input.maxAttempts).toBe(3);
        } finally {
            process.env.QUEUE_DRIVER = "redis";
        }
    });
});
