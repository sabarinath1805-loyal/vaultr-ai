import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// This is a real-stack regression: create a public relation using the same
// postgres connection configured for migrations, inspect its catalog ACL, then
// exercise PostgREST with anon, authenticated, and service_role credentials.
// The stack test harness exports SUPABASE_TEST_DB_URL for the owner-side SQL.
const url = process.env.SUPABASE_TEST_URL;
const serviceKey = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_TEST_ANON_KEY;
const databaseUrl = process.env.SUPABASE_TEST_DB_URL;
const maybeDescribe = url && serviceKey && anonKey && databaseUrl ? describe : describe.skip;

const suffix = randomUUID().replaceAll("-", "");
const tableName = `p3_default_acl_${suffix}`;
const ownerRowId = randomUUID();
const ownerCrudRowId = randomUUID();
const apiRowId = randomUUID();
const marker = `p3_marker_${suffix}`;
const tablePrivileges = [
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "TRUNCATE",
    "REFERENCES",
    "TRIGGER",
    "MAINTAIN",
] as const;
const serviceRoleTablePrivileges = new Set([
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
]);

type ApiRole = "anon" | "authenticated" | "service_role";

let admin: SupabaseClient | undefined;
let anonymous: SupabaseClient | undefined;
let userId = "";
let authenticatedToken = "";

function sql(statement: string): string {
    return execFileSync(
        "psql",
        [databaseUrl!, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", statement],
        { encoding: "utf8" },
    ).trim();
}

function apiURL(table: string, query = ""): string {
    return `${url!.replace(/\/$/, "")}/rest/v1/${table}${query}`;
}

function apiToken(role: ApiRole): string {
    if (role === "anon") return anonKey!;
    if (role === "authenticated") return authenticatedToken;
    return serviceKey!;
}

async function request(
    role: ApiRole,
    table: string,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    query = "",
    body?: Record<string, unknown>,
): Promise<Response> {
    const token = apiToken(role);
    return fetch(apiURL(table, query), {
        method,
        headers: {
            apikey: role === "service_role" ? serviceKey! : anonKey!,
            Authorization: `Bearer ${token}`,
            ...(body
                ? {
                      "Content-Type": "application/json",
                      Prefer: "return=representation",
                  }
                : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
}

async function waitForPostgrestTable(): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const response = await request(
            "service_role",
            tableName,
            "GET",
            `?select=id,marker&id=eq.${ownerRowId}`,
        );
        if (response.ok) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`PostgREST did not expose ${tableName} after schema reload`);
}

maybeDescribe("future public table default ACL", () => {
    beforeAll(async () => {
        admin = createClient(url!, serviceKey!, {
            auth: { persistSession: false, autoRefreshToken: false },
        });
        anonymous = createClient(url!, anonKey!, {
            auth: { persistSession: false, autoRefreshToken: false },
        });

        const createdUser = await admin.auth.admin.createUser({
            email: `p3-default-acl-${suffix}@test.local`,
            password: "StackTest123!",
            email_confirm: true,
        });
        if (createdUser.error || !createdUser.data.user) {
            throw createdUser.error ?? new Error("Could not create synthetic test user");
        }
        userId = createdUser.data.user.id;

        const login = await anonymous.auth.signInWithPassword({
            email: `p3-default-acl-${suffix}@test.local`,
            password: "StackTest123!",
        });
        if (login.error || !login.data.session) {
            throw login.error ?? new Error("Could not sign in synthetic test user");
        }
        authenticatedToken = login.data.session.access_token;

        sql(`
            create table public.${tableName} (
                id uuid primary key,
                marker text not null
            );
            insert into public.${tableName} (id, marker)
            values ('${ownerRowId}', '${marker}');
            notify pgrst, 'reload schema';
        `);
        await waitForPostgrestTable();
    }, 30_000);

    afterAll(async () => {
        const cleanupErrors: unknown[] = [];
        try {
            sql(`drop table if exists public.${tableName}; notify pgrst, 'reload schema';`);
        } catch (error) {
            cleanupErrors.push(error);
        }
        if (admin && userId) {
            const deleted = await admin.auth.admin.deleteUser(userId);
            if (deleted.error) cleanupErrors.push(deleted.error);
        }
        if (cleanupErrors.length) {
            throw new AggregateError(cleanupErrors, "Could not clean up default ACL canary");
        }
    });

    it("creates the canary as the migration owner with no browser-role table ACL", () => {
        const identity = JSON.parse(
            sql(`
                select json_build_object(
                    'current_user', current_user,
                    'session_user', session_user,
                    'owner', pg_get_userbyid(c.relowner)
                )::text
                from pg_class c
                where c.oid = 'public.${tableName}'::regclass;
            `),
        ) as { current_user: string; session_user: string; owner: string };
        expect(identity).toEqual({
            current_user: "postgres",
            session_user: "postgres",
            owner: "postgres",
        });

        const catalog = JSON.parse(
            sql(`
                with privileges(privilege) as (
                    values ${tablePrivileges.map((privilege) => `('${privilege}')`).join(", ")}
                )
                select jsonb_build_object(
                    'has_browser_acl', exists (
                        select 1
                        from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
                        where acl.grantee in (
                            select oid from pg_roles where rolname in ('anon', 'authenticated')
                        )
                    ),
                    'has_public_acl', exists (
                        select 1
                        from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
                        where acl.grantee = 0
                    ),
                    'has_grant_option', exists (
                        select 1
                        from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
                        where acl.is_grantable
                    ),
                    'anon', (
                        select jsonb_object_agg(privilege, has_table_privilege('anon', c.oid, privilege))
                        from privileges
                    ),
                    'authenticated', (
                        select jsonb_object_agg(privilege, has_table_privilege('authenticated', c.oid, privilege))
                        from privileges
                    ),
                    'service_role', (
                        select jsonb_object_agg(privilege, has_table_privilege('service_role', c.oid, privilege))
                        from privileges
                    )
                )::text
                from pg_class c
                where c.oid = 'public.${tableName}'::regclass;
            `),
        ) as {
            has_browser_acl: boolean;
            has_public_acl: boolean;
            has_grant_option: boolean;
            anon: Record<(typeof tablePrivileges)[number], boolean>;
            authenticated: Record<(typeof tablePrivileges)[number], boolean>;
            service_role: Record<(typeof tablePrivileges)[number], boolean>;
        };
        expect(catalog.has_browser_acl).toBe(false);
        expect(catalog.has_public_acl).toBe(false);
        expect(catalog.has_grant_option).toBe(false);
        for (const privilege of tablePrivileges) {
            expect(catalog.anon[privilege], `anon ${privilege}`).toBe(false);
            expect(catalog.authenticated[privilege], `authenticated ${privilege}`).toBe(
                false,
            );
            expect(
                catalog.service_role[privilege],
                `service_role ${privilege}`,
            ).toBe(serviceRoleTablePrivileges.has(privilege));
        }

        expect(
            Number(
                sql(`
                    select count(*)
                    from pg_default_acl d
                    join pg_namespace n on n.oid = d.defaclnamespace
                    cross join lateral aclexplode(d.defaclacl) acl
                    where n.nspname = 'public'
                      and d.defaclrole = 'postgres'::regrole
                      and d.defaclobjtype = 'r'
                      and acl.grantee in (
                          select oid from pg_roles where rolname in ('anon', 'authenticated')
                      );
                `),
            ),
        ).toBe(0);
    });

    it("keeps migration-owner table creation and CRUD working", () => {
        const ownerState = JSON.parse(
            sql(`
                select json_build_object(
                    'current_user', current_user,
                    'session_user', session_user,
                    'owner', pg_get_userbyid(c.relowner)
                )::text
                from pg_class c
                where c.oid = 'public.${tableName}'::regclass;
            `),
        ) as { current_user: string; session_user: string; owner: string };
        expect(ownerState.owner).toBe("postgres");
        expect(
            sql(`
                do $owner_crud$
                declare v_marker text;
                begin
                    insert into public.${tableName} (id, marker)
                    values ('${ownerCrudRowId}', 'owner-created');
                    select marker into v_marker from public.${tableName}
                    where id = '${ownerCrudRowId}';
                    if v_marker is distinct from 'owner-created' then
                        raise exception 'migration owner could not read its canary';
                    end if;
                    update public.${tableName} set marker = 'owner-updated'
                    where id = '${ownerCrudRowId}' returning marker into v_marker;
                    if v_marker is distinct from 'owner-updated' then
                        raise exception 'migration owner could not update its canary';
                    end if;
                    delete from public.${tableName} where id = '${ownerCrudRowId}'
                    returning marker into v_marker;
                    if v_marker is distinct from 'owner-updated' then
                        raise exception 'migration owner could not delete its canary';
                    end if;
                end;
                $owner_crud$;
            `),
        ).toBe("");
    });

    it("denies anon and authenticated GET, POST, PATCH, and DELETE on the canary", async () => {
        for (const role of ["anon", "authenticated"] as const) {
            const cases = [
                ["GET", `?select=id,marker&id=eq.${ownerRowId}`, undefined],
                ["POST", "", { id: apiRowId, marker: `${marker}-posted` }],
                ["PATCH", `?id=eq.${ownerRowId}`, { marker: `${marker}-patched` }],
                ["DELETE", `?id=eq.${ownerRowId}`, undefined],
            ] as const;
            for (const [method, query, body] of cases) {
                const response = await request(role, tableName, method, query, body);
                const responseText = await response.text();
                expect(
                    [401, 403],
                    `${role} ${method} should be denied; response was ${response.status}: ${responseText}`,
                ).toContain(response.status);
                expect(responseText.toLowerCase()).toMatch(/permission denied|42501/);
                expect(responseText).not.toContain(marker);
            }
        }
    });

    it("preserves service_role CRUD on the new table", async () => {
        const read = await request(
            "service_role",
            tableName,
            "GET",
            `?select=id,marker&id=eq.${ownerRowId}`,
        );
        expect(read.status).toBe(200);
        expect(await read.json()).toEqual([{ id: ownerRowId, marker }]);

        const updated = await request(
            "service_role",
            tableName,
            "PATCH",
            `?id=eq.${ownerRowId}`,
            { marker: `${marker}-service-updated` },
        );
        expect(updated.status).toBe(200);
        expect(await updated.json()).toEqual([
            { id: ownerRowId, marker: `${marker}-service-updated` },
        ]);

        const inserted = await request("service_role", tableName, "POST", "", {
            id: apiRowId,
            marker: `${marker}-service-inserted`,
        });
        expect(inserted.status).toBe(201);
        expect(await inserted.json()).toEqual([
            { id: apiRowId, marker: `${marker}-service-inserted` },
        ]);

        const deleted = await request(
            "service_role",
            tableName,
            "DELETE",
            `?id=eq.${apiRowId}`,
        );
        expect(deleted.status).toBe(204);
    });

    it("keeps db_jobs denied to browser roles and available to service_role", async () => {
        for (const role of ["anon", "authenticated"] as const) {
            const response = await request(
                role,
                "db_jobs",
                "GET",
                "?select=id&limit=1",
            );
            const responseText = await response.text();
            expect([401, 403], `${role} db_jobs GET response: ${responseText}`).toContain(
                response.status,
            );
        }

        const serviceResponse = await request(
            "service_role",
            "db_jobs",
            "GET",
            "?select=id&limit=1",
        );
        expect(serviceResponse.status).toBe(200);
    });

    it("preserves the existing browser-role revokes on workflow catalog tables", async () => {
        for (const table of [
            "default_workflow_installations",
            "quick_actions",
        ] as const) {
            for (const role of ["anon", "authenticated"] as const) {
                const hasSelect = sql(
                    `select has_table_privilege('${role}', 'public.${table}', 'SELECT');`,
                );
                expect(hasSelect, `${role} SELECT on ${table}`).toBe("f");

                const response = await request(
                    role,
                    table,
                    "GET",
                    "?select=*&limit=1",
                );
                expect([401, 403], `${role} GET on ${table}`).toContain(
                    response.status,
                );
                await response.text();
            }

            const serviceResponse = await request(
                "service_role",
                table,
                "GET",
                "?select=*&limit=1",
            );
            expect(serviceResponse.status, `service_role GET on ${table}`).toBe(
                200,
            );
        }
    });
});
