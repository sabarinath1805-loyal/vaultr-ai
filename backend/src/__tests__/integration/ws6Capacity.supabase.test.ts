import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Exercises the SQL admission paths against the disposable Supabase stack.
// The ordinary unit suite skips this file unless local stack credentials are
// explicitly supplied by the documented test-stack launcher.
const url = process.env.SUPABASE_TEST_URL;
const serviceKey = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
const maybeDescribe = url && serviceKey ? describe : describe.skip;

const uuid = () => randomUUID();
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

maybeDescribe("WS6 queue and upload capacity SQL", () => {
  let db: SupabaseClient;
  let userA = "";
  let userB = "";
  let orgId = "";
  let projectId = "";
  const sessions: string[] = [];
  const documents: string[] = [];
  const versions: string[] = [];
  const jobs: string[] = [];
  const extraProjects: string[] = [];
  const extraOrgs: string[] = [];

  beforeAll(async () => {
    db = createClient(url!, serviceKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const a = await db.auth.admin.createUser({
      email: `ws6-capacity-a-${suffix}@test.local`,
      password: "StackTest1!",
      email_confirm: true,
    });
    const b = await db.auth.admin.createUser({
      email: `ws6-capacity-b-${suffix}@test.local`,
      password: "StackTest1!",
      email_confirm: true,
    });
    if (a.error || !a.data.user) throw a.error ?? new Error("missing test user A");
    if (b.error || !b.data.user) throw b.error ?? new Error("missing test user B");
    userA = a.data.user.id;
    userB = b.data.user.id;

    orgId = uuid();
    projectId = uuid();
    const org = await db.from("organizations").insert({
      id: orgId,
      name: `WS6 capacity ${suffix}`,
      created_by: userA,
    });
    if (org.error) throw org.error;
    const members = await db.from("org_members").insert([
      { org_id: orgId, user_id: userA, role: "admin" },
      { org_id: orgId, user_id: userB, role: "member" },
    ]);
    if (members.error) throw members.error;
    const project = await db.from("projects").insert({
      id: projectId,
      user_id: userA,
      org_id: orgId,
      name: `WS6 capacity ${suffix}`,
    });
    if (project.error) throw project.error;
  });

  afterAll(async () => {
    if (sessions.length) await db.from("upload_sessions").delete().in("id", sessions);
    if (jobs.length) await db.from("db_jobs").delete().in("id", jobs);
    if (versions.length) await db.from("document_versions").delete().in("id", versions);
    if (documents.length) await db.from("documents").delete().in("id", documents);
    if (extraProjects.length) await db.from("projects").delete().in("id", extraProjects);
    if (projectId) await db.from("projects").delete().eq("id", projectId);
    if (extraOrgs.length) await db.from("organizations").delete().in("id", extraOrgs);
    if (orgId) await db.from("organizations").delete().eq("id", orgId);
    if (userA) await db.auth.admin.deleteUser(userA);
    if (userB) await db.auth.admin.deleteUser(userB);
  });

  function file(size: number) {
    const id = uuid();
    return {
      id,
      resource_id: uuid(),
      client_id: id,
      filename: `${id}.pdf`,
      target_folder_id: null,
      file_type: "pdf",
      content_type: "application/pdf",
      expected_size_bytes: size,
      staging_storage_path: `ws6-capacity/${id}/staging`,
      sealed_storage_path: `ws6-capacity/${id}/sealed`,
    };
  }

  async function createSession(input: {
    userId: string;
    size: number;
    userQuota?: number;
    orgQuota?: number;
    orgProject?: boolean;
    destinationProjectId?: string;
  }) {
    const sessionId = uuid();
    sessions.push(sessionId);
    const uploadFile = file(input.size);
    const result = await db.rpc("create_upload_session_with_capacity", {
      target_session_id: sessionId,
      target_user_id: input.userId,
      target_purpose: "document_create",
      target_destination: input.orgProject
        ? { scope: "project", project_id: input.destinationProjectId ?? projectId }
        : { scope: "standalone" },
      target_expires_at: new Date(Date.now() + 20 * 60_000).toISOString(),
      target_files: [uploadFile],
      target_hourly_session_limit: 50,
      target_user_storage_quota_bytes: input.userQuota ?? 0,
      target_org_storage_quota_bytes: input.orgQuota ?? 0,
    });
    return { result, sessionId, uploadFile };
  }

  it("enforces per-user and per-organization queued depth without blocking a peer user", async () => {
    const first = await db.rpc("enqueue_capped_db_job", {
      target_kind: "export.build",
      target_payload: { userId: userA, type: "account" },
      target_dedupe_key: `ws6:${suffix}:export:a`,
      target_max_attempts: 3,
      target_run_at: null,
      target_global_limit: 10,
      target_user_limit: 1,
      target_org_limit: 10,
    });
    expect(first.error).toBeNull();
    jobs.push(first.data[0].job_id);

    const sameUser = await db.rpc("enqueue_capped_db_job", {
      target_kind: "export.build",
      target_payload: { userId: userA, type: "audit-csv" },
      target_dedupe_key: `ws6:${suffix}:export:a-2`,
      target_max_attempts: 3,
      target_run_at: null,
      target_global_limit: 10,
      target_user_limit: 1,
      target_org_limit: 10,
    });
    expect(sameUser.error?.message).toContain("job_capacity_exceeded");

    const peer = await db.rpc("enqueue_capped_db_job", {
      target_kind: "export.build",
      target_payload: { userId: userB, type: "account" },
      target_dedupe_key: `ws6:${suffix}:export:b`,
      target_max_attempts: 3,
      target_run_at: null,
      target_global_limit: 10,
      target_user_limit: 1,
      target_org_limit: 10,
    });
    expect(peer.error).toBeNull();
    jobs.push(peer.data[0].job_id);

    const documentA = uuid();
    const documentB = uuid();
    documents.push(documentA, documentB);
    const inserted = await db.from("documents").insert([
      { id: documentA, user_id: userA, project_id: projectId, status: "ready" },
      { id: documentB, user_id: userB, project_id: projectId, status: "ready" },
    ]);
    expect(inserted.error).toBeNull();

    const orgFirst = await db.rpc("enqueue_capped_db_job", {
      target_kind: "conversion.convert",
      target_payload: {
        documentId: documentA,
        versionId: uuid(),
        userId: userA,
        storagePath: "ws6/a.docx",
      },
      target_dedupe_key: `ws6:${suffix}:doc:a`,
      target_max_attempts: 3,
      target_run_at: null,
      target_global_limit: 10,
      target_user_limit: 10,
      target_org_limit: 1,
    });
    expect(orgFirst.error).toBeNull();
    jobs.push(orgFirst.data[0].job_id);

    const orgSecond = await db.rpc("enqueue_capped_db_job", {
      target_kind: "conversion.convert",
      target_payload: {
        documentId: documentB,
        versionId: uuid(),
        userId: userB,
        storagePath: "ws6/b.docx",
      },
      target_dedupe_key: `ws6:${suffix}:doc:b`,
      target_max_attempts: 3,
      target_run_at: null,
      target_global_limit: 10,
      target_user_limit: 10,
      target_org_limit: 1,
    });
    expect(orgSecond.error?.message).toContain("job_capacity_exceeded");
  });

  it("enforces user and org upload reservations, including a completion-time recheck", async () => {
    const atUserQuota = await createSession({ userId: userA, size: 10, userQuota: 10 });
    expect(atUserQuota.result.error).toBeNull();

    const userOver = await createSession({ userId: userA, size: 1, userQuota: 10 });
    expect(userOver.result.error?.message).toContain("upload_storage_quota_exceeded");

    const otherUser = await createSession({ userId: userB, size: 5, userQuota: 10 });
    expect(otherUser.result.error).toBeNull();

    // During upload processing the destination version can already be durable
    // while its upload-session reservation is still active. Quota accounting
    // must count that source once, not once as committed bytes and again as a
    // reservation, or unrelated uploads are rejected near the configured cap.
    const inFlight = await createSession({ userId: userB, size: 8 });
    expect(inFlight.result.error).toBeNull();
    const inFlightState = await db
      .from("upload_sessions")
      .update({ status: "processing" })
      .eq("id", inFlight.sessionId);
    expect(inFlightState.error).toBeNull();
    const inFlightFile = await db
      .from("upload_session_files")
      .update({ status: "processing", observed_size_bytes: 8 })
      .eq("id", inFlight.uploadFile.id);
    expect(inFlightFile.error).toBeNull();
    const inFlightDocumentId = inFlight.uploadFile.resource_id;
    const inFlightVersionId = inFlight.uploadFile.id;
    documents.push(inFlightDocumentId);
    versions.push(inFlightVersionId);
    const inFlightDocument = await db.from("documents").insert({
      id: inFlightDocumentId,
      user_id: userB,
      status: "ready",
    });
    expect(inFlightDocument.error).toBeNull();
    const inFlightVersion = await db.from("document_versions").insert({
      id: inFlightVersionId,
      document_id: inFlightDocumentId,
      storage_path: `ws6-capacity/${inFlightVersionId}`,
      source: "upload",
      version_number: 1,
      filename: "in-flight.pdf",
      file_type: "pdf",
      size_bytes: 8,
    });
    expect(inFlightVersion.error).toBeNull();
    const duringProcessing = await createSession({
      userId: userB,
      size: 1,
      userQuota: 15,
    });
    expect(duringProcessing.result.error).toBeNull();

    const orgReservation = await createSession({
      userId: userA,
      size: 10,
      orgProject: true,
      orgQuota: 15,
    });
    expect(orgReservation.result.error).toBeNull();
    const orgOver = await createSession({
      userId: userB,
      size: 6,
      orgProject: true,
      orgQuota: 15,
    });
    expect(orgOver.result.error?.message).toContain("upload_storage_quota_exceeded");
    await db.from("upload_sessions").delete().eq("id", orgReservation.sessionId);

    const documentId = uuid();
    const versionId = uuid();
    documents.push(documentId);
    versions.push(versionId);
    const document = await db.from("documents").insert({
      id: documentId,
      user_id: userA,
      project_id: projectId,
      status: "ready",
    });
    expect(document.error).toBeNull();
    const version = await db.from("document_versions").insert({
      id: versionId,
      document_id: documentId,
      storage_path: `ws6-capacity/${versionId}`,
      source: "upload",
      version_number: 1,
      filename: "existing.pdf",
      file_type: "pdf",
      size_bytes: 15,
    });
    expect(version.error).toBeNull();

    const completion = await createSession({
      userId: userB,
      size: 10,
      orgProject: true,
    });
    expect(completion.result.error).toBeNull();
    const fileStatus = await db
      .from("upload_session_files")
      .update({ status: "uploaded", observed_size_bytes: 10 })
      .eq("id", completion.uploadFile.id);
    expect(fileStatus.error).toBeNull();

    const rejectedAtCompletion = await db.rpc(
      "queue_upload_session_file_processing_with_capacity",
      {
        target_session_id: completion.sessionId,
        target_user_id: userB,
        target_file_id: completion.uploadFile.id,
        target_global_queue_limit: 100,
        target_user_queue_limit: 100,
        target_org_queue_limit: 100,
        target_user_storage_quota_bytes: 0,
        target_org_storage_quota_bytes: 20,
      },
    );
    expect(rejectedAtCompletion.error?.message).toContain("upload_storage_quota_exceeded");

    const noJob = await db
      .from("upload_processing_jobs")
      .select("id")
      .eq("file_id", completion.uploadFile.id);
    expect(noJob.error).toBeNull();
    expect(noJob.data).toEqual([]);
  });

  it("returns excess concurrent claims to pending without spending an attempt", async () => {
    const owner = uuid();
    const claimTime = new Date().toISOString();
    const inserted = await db.from("db_jobs").insert([
      {
        kind: "export.build",
        payload: { userId: owner },
        status: "running",
        attempts: 1,
        max_attempts: 3,
        claimed_at: claimTime,
        capacity_class: "export",
        capacity_user_id: owner,
      },
      {
        kind: "export.build",
        payload: { userId: owner },
        status: "running",
        attempts: 1,
        max_attempts: 3,
        claimed_at: claimTime,
        capacity_class: "export",
        capacity_user_id: owner,
      },
    ]).select("id");
    expect(inserted.error).toBeNull();
    const [first, second] = inserted.data!;
    jobs.push(first.id, second.id);

    const admitted = await db.rpc("acquire_db_job_execution_capacity", {
      target_job_id: first.id,
      target_attempts: 1,
      target_claimed_at: claimTime,
      target_max_concurrent: 1,
    });
    expect(admitted.error).toBeNull();
    expect(admitted.data).toBe(false);
    const deferred = await db
      .from("db_jobs")
      .select("status, attempts, claimed_at, run_at")
      .eq("id", first.id)
      .single();
    expect(deferred.error).toBeNull();
    expect(deferred.data).toMatchObject({ status: "pending", attempts: 0, claimed_at: null });
    expect(Date.parse(deferred.data!.run_at)).toBeGreaterThan(Date.now());
  });

  it("does not let stale upload attribution block organization deletion", async () => {
    const staleOrgId = uuid();
    const staleProjectId = uuid();
    extraOrgs.push(staleOrgId);
    extraProjects.push(staleProjectId);

    const org = await db.from("organizations").insert({
      id: staleOrgId,
      name: `WS6 stale upload ${suffix}`,
      created_by: userA,
    });
    expect(org.error).toBeNull();
    const project = await db.from("projects").insert({
      id: staleProjectId,
      user_id: userA,
      org_id: staleOrgId,
      name: `WS6 stale upload ${suffix}`,
    });
    expect(project.error).toBeNull();

    const session = await createSession({
      userId: userA,
      size: 1,
      orgProject: true,
      destinationProjectId: staleProjectId,
    });
    expect(session.result.error).toBeNull();
    const attributed = await db
      .from("upload_sessions")
      .select("org_id")
      .eq("id", session.sessionId)
      .single();
    expect(attributed.error).toBeNull();
    expect(attributed.data?.org_id).toBe(staleOrgId);

    const deleteProject = await db.from("projects").delete().eq("id", staleProjectId);
    expect(deleteProject.error).toBeNull();
    const deleteOrg = await db.from("organizations").delete().eq("id", staleOrgId);
    expect(deleteOrg.error).toBeNull();

    const retainedSession = await db
      .from("upload_sessions")
      .select("org_id")
      .eq("id", session.sessionId)
      .single();
    expect(retainedSession.error).toBeNull();
    expect(retainedSession.data?.org_id).toBeNull();
  });
});
