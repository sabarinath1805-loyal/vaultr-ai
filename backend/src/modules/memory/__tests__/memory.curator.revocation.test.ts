import { describe, expect, it } from "vitest";
import { authorizeMemoryDisclosure } from "../memory.curator";

function memoryDb(args: { projectOwner: string; grants?: unknown[] }) {
  const rows: Record<string, unknown[]> = {
    chats: [
      {
        id: "chat-1",
        user_id: "actor-1",
        project_id: "project-1",
        org_id: null,
      },
    ],
    projects: [
      {
        id: "project-1",
        user_id: args.projectOwner,
        org_id: null,
      },
    ],
    project_access_grants: args.grants ?? [],
    chat_access_grants: [],
  };

  return {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const query: Record<string, unknown> = {};
      query.select = () => query;
      query.eq = (column: string, value: unknown) => {
        filters.push([column, value]);
        return query;
      };
      query.limit = () => query;
      query.maybeSingle = async () => ({
        data:
          (rows[table] ?? []).find((row) =>
            filters.every(
              ([column, value]) =>
                (row as Record<string, unknown>)[column] === value,
            ),
          ) ?? null,
        error: null,
      });
      query.then = (resolve: (result: unknown) => unknown) =>
        Promise.resolve({
          data: (rows[table] ?? []).filter((row) =>
            filters.every(
              ([column, value]) =>
                (row as Record<string, unknown>)[column] === value,
            ),
          ),
          error: null,
        }).then(resolve);
      return query;
    },
  };
}

const state = {
  id: "state-1",
  surface: "chat" as const,
  conversation_id: "chat-1",
  actor_user_id: "actor-1",
  project_id: "project-1",
  generation: 2,
  processed_generation: 1,
  latest_turn_id: "turn-1",
  status: "processing",
};

describe("memory transcript disclosure authorization", () => {
  it("denies a captured project transcript after the actor's project grant is gone", async () => {
    const db = memoryDb({ projectOwner: "owner-2" });

    await expect(
      authorizeMemoryDisclosure({
        db: db as never,
        state,
        actorEmail: "actor@example.com",
        expectedProjectId: "project-1",
        scope: "user",
      }),
    ).resolves.toBe(false);
  });

  it("allows private project conversation evidence when access remains current", async () => {
    const db = memoryDb({ projectOwner: "actor-1" });

    await expect(
      authorizeMemoryDisclosure({
        db: db as never,
        state,
        actorEmail: "actor@example.com",
        expectedProjectId: "project-1",
        scope: "user",
      }),
    ).resolves.toBe(true);
  });
});
