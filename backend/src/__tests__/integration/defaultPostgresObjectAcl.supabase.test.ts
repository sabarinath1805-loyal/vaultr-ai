import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.SUPABASE_TEST_URL;
const serviceKey = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_TEST_ANON_KEY;
const databaseUrl = process.env.SUPABASE_TEST_DB_URL;
const maybeDescribe = url && serviceKey && anonKey && databaseUrl ? describe : describe.skip;

const suffix = randomUUID().replaceAll("-", "");
const tableName = `w2_acl_${suffix}`;
const sequenceName = `w2_acl_seq_${suffix}`;
const viewName = `w2_acl_view_${suffix}`;
const negativeFunction = `w2_acl_negative_${suffix}`;
const positiveFunction = `w2_acl_positive_${suffix}`;
const marker = `w2_marker_${suffix}`;
const allTablePrivileges = [
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "TRUNCATE",
    "REFERENCES",
    "TRIGGER",
    "MAINTAIN",
] as const;

type ApiRole = "anon" | "authenticated" | "service_role";
type DefaultAclRow = {
    grantor: string;
    grantee: string;
    privilege: string;
    grantable: boolean;
};

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

function sqlFailure(statement: string): { status: number; output: string } {
    try {
        execFileSync(
            "psql",
            [databaseUrl!, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", statement],
            { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        );
        return { status: 0, output: "" };
    } catch (error) {
        const failure = error as NodeJS.ErrnoException & {
            status?: number;
            stderr?: Buffer | string;
            stdout?: Buffer | string;
        };
        return {
            status: failure.status ?? 1,
            output: `${failure.stderr?.toString() ?? ""}${failure.stdout?.toString() ?? ""}`,
        };
    }
}

function apiUrl(path: string): string {
    return `${url!.replace(/\/$/, "")}/rest/v1/${path}`;
}

function tokenFor(role: ApiRole): string {
    if (role === "anon") return anonKey!;
    if (role === "authenticated") return authenticatedToken;
    return serviceKey!;
}

async function request(
    role: ApiRole,
    path: string,
    method: "GET" | "POST" = "GET",
    body?: Record<string, unknown>,
): Promise<Response> {
    const token = tokenFor(role);
    return fetch(apiUrl(path), {
        method,
        headers: {
            apikey: role === "service_role" ? serviceKey! : anonKey!,
            Authorization: `Bearer ${token}`,
            ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
}

async function expectDenied(response: Response, label: string): Promise<void> {
    const responseText = await response.text();
    expect([401, 403, 404], `${label} status: ${response.status} ${responseText}`).toContain(
        response.status,
    );
    expect(responseText).not.toContain(marker);
}

function defaultAcl(objectClass: "r" | "S" | "f", scope: "global" | "public"): DefaultAclRow[] {
    const scopePredicate =
        scope === "global"
            ? "d.defaclnamespace = 0"
            : "n.nspname = 'public'";
    const raw = sql(`
        select coalesce(
            jsonb_agg(
                jsonb_build_object(
                    'grantor', pg_get_userbyid(acl.grantor),
                    'grantee', case when acl.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end,
                    'privilege', acl.privilege_type,
                    'grantable', acl.is_grantable
                )
            ),
            '[]'::jsonb
        )::text
        from pg_default_acl d
        left join pg_namespace n on n.oid = d.defaclnamespace
        cross join lateral aclexplode(d.defaclacl) acl
        where d.defaclrole = 'postgres'::regrole
          and d.defaclobjtype = '${objectClass}'
          and ${scopePredicate};
    `);
    return (JSON.parse(raw) as DefaultAclRow[]).sort((a, b) =>
        `${a.grantee}|${a.privilege}|${a.grantable}`.localeCompare(
            `${b.grantee}|${b.privilege}|${b.grantable}`,
        ),
    );
}

function expectedDefaultAcl(
    grants: Array<[grantee: string, privileges: string[]]>,
): DefaultAclRow[] {
    return grants
        .flatMap(([grantee, privileges]) =>
            privileges.map((privilege) => ({
                grantor: "postgres",
                grantee,
                privilege,
                grantable: false,
            })),
        )
        .sort((a, b) =>
            `${a.grantee}|${a.privilege}|${a.grantable}`.localeCompare(
                `${b.grantee}|${b.privilege}|${b.grantable}`,
            ),
        );
}

async function waitForPostgrest(): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const view = await request("service_role", `${viewName}?select=marker`);
        const fn = await request(
            "service_role",
            `rpc/${negativeFunction}`,
            "POST",
            {},
        );
        if (view.ok && fn.ok) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("PostgREST did not expose the disposable object canaries");
}

maybeDescribe("future postgres public object defaults", () => {
    beforeAll(async () => {
        admin = createClient(url!, serviceKey!, {
            auth: { persistSession: false, autoRefreshToken: false },
        });
        anonymous = createClient(url!, anonKey!, {
            auth: { persistSession: false, autoRefreshToken: false },
        });

        const created = await admin.auth.admin.createUser({
            email: `w2-acl-${suffix}@test.local`,
            password: "StackTest123!",
            email_confirm: true,
        });
        if (created.error || !created.data.user) {
            throw created.error ?? new Error("Could not create synthetic W2 test user");
        }
        userId = created.data.user.id;

        const login = await anonymous.auth.signInWithPassword({
            email: `w2-acl-${suffix}@test.local`,
            password: "StackTest123!",
        });
        if (login.error || !login.data.session) {
            throw login.error ?? new Error("Could not authenticate synthetic W2 test user");
        }
        authenticatedToken = login.data.session.access_token;

        sql(`
            create table public.${tableName} (id integer primary key, marker text not null);
            insert into public.${tableName} (id, marker) values (1, '${marker}');
            create sequence public.${sequenceName};
            create view public.${viewName} as
              select marker from public.${tableName};
            create function public.${negativeFunction}()
            returns text language sql security definer
            set search_path = pg_catalog
            as $$ select '${marker}'::text $$;
            create function public.${positiveFunction}(p_expected uuid)
            returns boolean language sql security invoker
            set search_path = pg_catalog
            as $$ select auth.uid() = p_expected $$;
            notify pgrst, 'reload schema';
        `);
        await waitForPostgrest();
    }, 30_000);

    afterAll(async () => {
        const cleanupErrors: unknown[] = [];
        try {
            sql(`
                drop view if exists public.${viewName};
                drop function if exists public.${negativeFunction}();
                drop function if exists public.${positiveFunction}(uuid);
                drop sequence if exists public.${sequenceName};
                drop table if exists public.${tableName};
                notify pgrst, 'reload schema';
            `);
        } catch (error) {
            cleanupErrors.push(error);
        }
        if (admin && userId) {
            const deleted = await admin.auth.admin.deleteUser(userId);
            if (deleted.error) cleanupErrors.push(deleted.error);
        }
        if (cleanupErrors.length) {
            throw new AggregateError(cleanupErrors, "Could not clean up W2 ACL canaries");
        }
    });

    it("records exact future default ACLs for postgres and the service role", () => {
        expect(defaultAcl("r", "public")).toEqual(
            expectedDefaultAcl([
                ["postgres", [...allTablePrivileges]],
                ["service_role", ["SELECT", "INSERT", "UPDATE", "DELETE"]],
            ]),
        );
        expect(defaultAcl("S", "public")).toEqual(
            expectedDefaultAcl([
                ["postgres", ["USAGE", "SELECT", "UPDATE"]],
                ["service_role", ["USAGE", "SELECT"]],
            ]),
        );
        expect(defaultAcl("f", "global")).toEqual(
            expectedDefaultAcl([["postgres", ["EXECUTE"]]]),
        );
        expect(defaultAcl("f", "public")).toEqual(
            expectedDefaultAcl([
                ["postgres", ["EXECUTE"]],
                ["service_role", ["EXECUTE"]],
            ]),
        );
    });

    it("creates a sequence with no browser privileges and only service USAGE and SELECT", () => {
        const state = JSON.parse(
            sql(`
                select jsonb_build_object(
                    'owner', pg_get_userbyid(c.relowner),
                    'anon', jsonb_build_array(
                        has_sequence_privilege('anon', c.oid, 'USAGE'),
                        has_sequence_privilege('anon', c.oid, 'SELECT'),
                        has_sequence_privilege('anon', c.oid, 'UPDATE')
                    ),
                    'authenticated', jsonb_build_array(
                        has_sequence_privilege('authenticated', c.oid, 'USAGE'),
                        has_sequence_privilege('authenticated', c.oid, 'SELECT'),
                        has_sequence_privilege('authenticated', c.oid, 'UPDATE')
                    ),
                    'service_role', jsonb_build_array(
                        has_sequence_privilege('service_role', c.oid, 'USAGE'),
                        has_sequence_privilege('service_role', c.oid, 'SELECT'),
                        has_sequence_privilege('service_role', c.oid, 'UPDATE')
                    ),
                    'public_acl', exists (
                        select 1 from aclexplode(coalesce(c.relacl, acldefault('s', c.relowner))) acl
                        where acl.grantee = 0
                    ),
                    'grantable', exists (
                        select 1 from aclexplode(coalesce(c.relacl, acldefault('s', c.relowner))) acl
                        where acl.is_grantable
                    )
                )::text
                from pg_class c
                where c.oid = 'public.${sequenceName}'::regclass;
            `),
        ) as {
            owner: string;
            anon: boolean[];
            authenticated: boolean[];
            service_role: boolean[];
            public_acl: boolean;
            grantable: boolean;
        };
        expect(state).toEqual({
            owner: "postgres",
            anon: [false, false, false],
            authenticated: [false, false, false],
            service_role: [true, true, false],
            public_acl: false,
            grantable: false,
        });

        const serviceOperations = sql(`
            set role service_role;
            select nextval('public.${sequenceName}'::regclass);
            select currval('public.${sequenceName}'::regclass);
            reset role;
        `);
        expect(serviceOperations.split("\n")).toHaveLength(2);
        expect(sqlFailure(`set role service_role; select setval('public.${sequenceName}'::regclass, 9);`).output).toMatch(
            /permission denied for sequence/,
        );
        expect(sqlFailure(`set role anon; select nextval('public.${sequenceName}'::regclass);`).output).toMatch(
            /permission denied for sequence/,
        );
        expect(sqlFailure(`set role authenticated; select nextval('public.${sequenceName}'::regclass);`).output).toMatch(
            /permission denied for sequence/,
        );
        expect(
            sql(`
                select nextval('public.${sequenceName}'::regclass);
                select currval('public.${sequenceName}'::regclass);
                select setval('public.${sequenceName}'::regclass, 20);
            `).split("\n"),
        ).toEqual(["2", "2", "20"]);
    });

    it("denies browser reads of a future view while preserving service and owner reads", async () => {
        for (const role of ["anon", "authenticated"] as const) {
            await expectDenied(
                await request(role, `${viewName}?select=marker`),
                `${role} GET on ${viewName}`,
            );
        }

        const service = await request("service_role", `${viewName}?select=marker`);
        expect(service.status).toBe(200);
        expect(await service.json()).toEqual([{ marker }]);
        expect(sql(`select marker from public.${viewName};`)).toBe(marker);
    });

    it("denies an ungranted SECURITY DEFINER function through PostgREST", async () => {
        const state = JSON.parse(
            sql(`
                select jsonb_build_object(
                    'owner', pg_get_userbyid(p.proowner),
                    'security_definer', p.prosecdef,
                    'safe_search_path', p.proconfig @> array['search_path=pg_catalog'],
                    'public_execute', exists (
                        select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
                        where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
                    ),
                    'anon_execute', has_function_privilege('anon', p.oid, 'EXECUTE'),
                    'authenticated_execute', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
                    'service_execute', has_function_privilege('service_role', p.oid, 'EXECUTE'),
                    'grantable', exists (
                        select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
                        where acl.is_grantable
                    )
                )::text
                from pg_proc p
                where p.oid = 'public.${negativeFunction}()'::regprocedure;
            `),
        ) as Record<string, unknown>;
        expect(state).toEqual({
            owner: "postgres",
            security_definer: true,
            safe_search_path: true,
            public_execute: false,
            anon_execute: false,
            authenticated_execute: false,
            service_execute: true,
            grantable: false,
        });

        await expectDenied(
            await request("anon", `rpc/${negativeFunction}`, "POST", {}),
            "anon ungranted SECURITY DEFINER RPC",
        );
        await expectDenied(
            await request("authenticated", `rpc/${negativeFunction}`, "POST", {}),
            "authenticated ungranted SECURITY DEFINER RPC",
        );
        const service = await request("service_role", `rpc/${negativeFunction}`, "POST", {});
        expect(service.status).toBe(200);
        expect(await service.json()).toBe(marker);
        expect(sql(`select public.${negativeFunction}();`)).toBe(marker);
    });

    it("allows an RPC only after an explicit authenticated grant and still checks its body", async () => {
        const expected = userId;
        await expectDenied(
            await request("anon", `rpc/${positiveFunction}`, "POST", {
                p_expected: expected,
            }),
            "anon positive-control RPC before grant",
        );
        await expectDenied(
            await request("authenticated", `rpc/${positiveFunction}`, "POST", {
                p_expected: expected,
            }),
            "authenticated positive-control RPC before grant",
        );

        sql(`
            grant execute on function public.${positiveFunction}(uuid) to authenticated;
            notify pgrst, 'reload schema';
        `);

        const granted = await request("authenticated", `rpc/${positiveFunction}`, "POST", {
            p_expected: expected,
        });
        expect(granted.status).toBe(200);
        expect(await granted.json()).toBe(true);

        const wrongSubject = await request(
            "authenticated",
            `rpc/${positiveFunction}`,
            "POST",
            { p_expected: randomUUID() },
        );
        expect(wrongSubject.status).toBe(200);
        expect(await wrongSubject.json()).toBe(false);
        await expectDenied(
            await request("anon", `rpc/${positiveFunction}`, "POST", {
                p_expected: expected,
            }),
            "anon positive-control RPC after authenticated grant",
        );

        const acl = JSON.parse(
            sql(`
                select jsonb_build_object(
                    'public_execute', exists (
                        select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
                        where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
                    ),
                    'anon_execute', has_function_privilege('anon', p.oid, 'EXECUTE'),
                    'authenticated_execute', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
                    'service_execute', has_function_privilege('service_role', p.oid, 'EXECUTE'),
                    'grantable', exists (
                        select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
                        where acl.is_grantable
                    )
                )::text
                from pg_proc p
                where p.oid = 'public.${positiveFunction}(uuid)'::regprocedure;
            `),
        ) as Record<string, unknown>;
        expect(acl).toEqual({
            public_execute: false,
            anon_execute: false,
            authenticated_execute: true,
            service_execute: true,
            grantable: false,
        });

        const service = await request(
            "service_role",
            `rpc/${positiveFunction}`,
            "POST",
            { p_expected: expected },
        );
        expect(service.status).toBe(200);
    });
});
