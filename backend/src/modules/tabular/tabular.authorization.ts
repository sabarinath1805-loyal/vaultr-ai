import { can, ensureDocAccess, ensureReviewAccess } from "../../lib/access";
import type { Db } from "../../lib/supabase";
import type { SourceDocument } from "./tabular.rows";

export class TabularAccessRevokedError extends Error {
    constructor() {
        super("tabular_access_revoked");
        this.name = "TabularAccessRevokedError";
    }
}

/** Recheck current review visibility and edit authority before extraction. */
export async function assertTabularReviewEditAccess(
    db: Db,
    reviewId: string,
    userId: string,
    userEmail: string | null,
): Promise<void> {
    const { data: review, error } = await db
        .from("tabular_reviews")
        .select("id, user_id, project_id, org_id")
        .eq("id", reviewId)
        .maybeSingle();
    if (error) throw error;
    if (!review) throw new TabularAccessRevokedError();
    const access = await ensureReviewAccess(
        review as {
            id: string;
            user_id: string | null;
            project_id: string | null;
            org_id?: string | null;
        },
        userId,
        userEmail,
        db,
    );
    if (!access.ok || !can(access.projectRole, "content.edit")) {
        throw new TabularAccessRevokedError();
    }
}

/** Recheck current source ownership/project/workflow access before bytes read. */
export async function assertTabularSourceReadAccess(
    db: Db,
    document: SourceDocument | string,
    userId: string,
    userEmail: string | null,
): Promise<void> {
    const documentId = typeof document === "string" ? document : document.id;
    const { data: current, error } = await db
        .from("documents")
        .select("id, user_id, project_id, org_id, workflow_id")
        .eq("id", documentId)
        .maybeSingle();
    if (error) throw error;
    if (!current) throw new TabularAccessRevokedError();
    const access = await ensureDocAccess(
        current as {
            user_id: string | null;
            project_id: string | null;
            org_id?: string | null;
            workflow_id?: string | null;
        },
        userId,
        userEmail,
        db,
    );
    if (!access.ok) throw new TabularAccessRevokedError();
}
