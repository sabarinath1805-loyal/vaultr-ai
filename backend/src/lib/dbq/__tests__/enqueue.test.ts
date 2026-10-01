import { describe, it, expect, vi, beforeEach } from "vitest";

// Typed with the real deleteFile's signature so the recorded calls are a
// proper argument tuple rather than an untyped rest array.
const deleteFile = vi.fn<(key: string) => Promise<void>>(async () => {});
vi.mock("../../storage", () => ({
    deleteFile: (key: string) => deleteFile(key),
}));

import { enqueueDbJob, enqueueStorageCleanup } from "../enqueue";

// db double: insert(...).select(...).single() resolves `insertResult`;
// the dedupe lookup select(...).eq/in/limit/maybeSingle resolves `existing`.
function makeDb(opts: {
    insertResult: { data: unknown; error: { code?: string; message: string } | null };
    existing?: { id: string } | null;
    rpcResult?: { data: unknown; error: { code?: string; message: string } | null };
}) {
    const inserts: Record<string, unknown>[] = [];
    const rpcs: Array<{ name: string; params: Record<string, unknown> }> = [];
    function from() {
        const b: Record<string, unknown> = {
            insert(payload: Record<string, unknown>) {
                inserts.push(payload);
                return b;
            },
            select() {
                return b;
            },
            eq() {
                return b;
            },
            in() {
                return b;
            },
            limit() {
                return b;
            },
            single() {
                return Promise.resolve(opts.insertResult);
            },
            maybeSingle() {
                return Promise.resolve({
                    data: opts.existing ?? null,
                    error: null,
                });
            },
        };
        return b;
    }
    async function rpc(name: string, params: Record<string, unknown>) {
        rpcs.push({ name, params });
        return opts.rpcResult ?? { data: [{ job_id: "capped-job", deduped: false }], error: null };
    }
    return { inserts, rpcs, from, rpc };
}

beforeEach(() => deleteFile.mockClear());

describe("enqueueDbJob", () => {
    it("inserts the job and returns its id", async () => {
        const db = makeDb({
            insertResult: { data: { id: "j1" }, error: null },
        });
        const out = await enqueueDbJob(db as never, {
            kind: "audit.chat_turn",
            payload: { userId: "u" },
            dedupeKey: "export:u:account",
            maxAttempts: 3,
        });
        expect(out).toEqual({ id: "j1", deduped: false });
        expect(db.inserts[0]).toMatchObject({
            kind: "audit.chat_turn",
            dedupe_key: "export:u:account",
            max_attempts: 3,
        });
    });

    it("treats a unique violation on the dedupe key as success (already queued)", async () => {
        const db = makeDb({
            insertResult: {
                data: null,
                error: { code: "23505", message: "duplicate key value" },
            },
            existing: { id: "live-1" },
        });
        const out = await enqueueDbJob(db as never, {
            kind: "audit.chat_turn",
            payload: {},
            dedupeKey: "export:u:account",
        });
        expect(out).toEqual({ id: "live-1", deduped: true });
    });

    it("throws on real insert failures so callers can fall back", async () => {
        const db = makeDb({
            insertResult: {
                data: null,
                error: { code: "XX000", message: "connection refused" },
            },
        });
        await expect(
            enqueueDbJob(db as never, { kind: "x", payload: {} }),
        ).rejects.toThrow(/connection refused/);
    });

    it("uses the transactional Postgres admission function for capped jobs", async () => {
        const db = makeDb({
            insertResult: { data: { id: "unused" }, error: null },
            rpcResult: { data: [{ job_id: "capped-job", deduped: false }], error: null },
        });
        const out = await enqueueDbJob(db as never, {
            kind: "export.build",
            payload: { userId: "synthetic-user" },
            dedupeKey: "export:synthetic-user:account",
            maxAttempts: 3,
        });
        expect(out).toEqual({ id: "capped-job", deduped: false });
        expect(db.rpcs).toHaveLength(1);
        expect(db.rpcs[0].name).toBe("enqueue_capped_db_job");
        expect(db.rpcs[0].params).toMatchObject({
            target_kind: "export.build",
            target_payload: { userId: "synthetic-user" },
            target_dedupe_key: "export:synthetic-user:account",
            target_global_limit: 500,
            target_user_limit: 100,
            target_org_limit: 200,
        });
        expect(db.inserts).toHaveLength(0);
    });

    it("returns dedupe success without making a second capacity reservation", async () => {
        const db = makeDb({
            insertResult: { data: { id: "unused" }, error: null },
            rpcResult: { data: [{ job_id: "live-job", deduped: true }], error: null },
        });
        await expect(
            enqueueDbJob(db as never, {
                kind: "extraction.extract",
                payload: { userId: "user", reviewId: "review", rowId: "row" },
                dedupeKey: "extract:review:row",
            }),
        ).resolves.toEqual({ id: "live-job", deduped: true });
        expect(db.rpcs).toHaveLength(1);
    });

    it("maps a full queue to a controlled capacity error", async () => {
        const db = makeDb({
            insertResult: { data: null, error: null },
            rpcResult: {
                data: null,
                error: { code: "P0001", message: "job_capacity_exceeded" },
            },
        });
        await expect(
            enqueueDbJob(db as never, {
                kind: "conversion.convert",
                payload: { userId: "user", documentId: "doc" },
            }),
        ).rejects.toMatchObject({ name: "JobCapacityExceededError", code: "job_capacity_exceeded" });
    });
});

describe("enqueueStorageCleanup", () => {
    it("is a no-op with nothing to clean", async () => {
        const db = makeDb({ insertResult: { data: { id: "j" }, error: null } });
        await enqueueStorageCleanup(db as never, []);
        expect(db.inserts).toHaveLength(0);
    });

    it("falls back to inline best-effort deletes when the enqueue fails", async () => {
        const db = makeDb({
            insertResult: {
                data: null,
                error: { code: "XX000", message: "db down" },
            },
        });
        await enqueueStorageCleanup(db as never, ["a.pdf", "b.pdf"]);
        expect(deleteFile).toHaveBeenCalledTimes(2);
    });

    it("never throws even when the inline fallback also fails", async () => {
        deleteFile.mockRejectedValueOnce(new Error("storage down"));
        const db = makeDb({
            insertResult: {
                data: null,
                error: { code: "XX000", message: "db down" },
            },
        });
        await expect(
            enqueueStorageCleanup(db as never, ["a.pdf"]),
        ).resolves.toBeUndefined();
        expect(deleteFile).toHaveBeenCalledTimes(1);
    });
});
