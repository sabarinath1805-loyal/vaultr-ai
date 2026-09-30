import {
  PROJECT_EXTRA_TOOLS,
  TABULAR_TOOLS,
  TOOLS,
  WORKFLOW_TOOLS,
} from "./toolSchemas";
import {
  COURTLISTENER_TOOLS,
  COURTLISTENER_TOOL_NAMES,
} from "./courtlistenerTools";

export type ToolCapability =
  | "read"
  | "write"
  | "provider-disclosure"
  | "external-dispatch"
  | "none";

/**
 * Capabilities for every built-in server tool. Dynamic connector tools use
 * the prefix rules below; client-side schemas are intentionally excluded.
 */
export const SERVER_TOOL_CAPABILITIES = {
  ask_inputs: "none",
  read_document: "read",
  find_in_document: "read",
  list_documents: "read",
  fetch_documents: "read",
  read_table_cells: "read",
  list_workflows: "read",
  read_workflow: "read",
  replicate_document: "write",
  generate_docx: "write",
  generate_excel: "write",
  generate_ppt: "write",
  edit_document: "write",
  courtlistener_search_case_law: "external-dispatch",
  courtlistener_get_cases: "external-dispatch",
  courtlistener_find_in_case: "external-dispatch",
  courtlistener_read_case: "external-dispatch",
  courtlistener_verify_citations: "external-dispatch",
} as const satisfies Record<string, ToolCapability>;

function schemaName(schema: unknown): string | null {
  const name = (schema as { function?: { name?: unknown } } | null)?.function
    ?.name;
  return typeof name === "string" ? name : null;
}

export const REGISTERED_SERVER_TOOL_SCHEMAS: readonly unknown[] = [
  ...TOOLS,
  ...PROJECT_EXTRA_TOOLS,
  ...TABULAR_TOOLS,
  ...WORKFLOW_TOOLS,
  ...COURTLISTENER_TOOLS,
];

export const REGISTERED_SERVER_TOOL_NAMES: readonly string[] = [
  ...new Set([
    ...REGISTERED_SERVER_TOOL_SCHEMAS.map(schemaName).filter(
      (name): name is string => name !== null,
    ),
    ...Object.values(COURTLISTENER_TOOL_NAMES),
  ]),
];

export function toolCapabilityFor(name: string): ToolCapability | null {
  const exact = SERVER_TOOL_CAPABILITIES[name as keyof typeof SERVER_TOOL_CAPABILITIES];
  if (exact) return exact;
  if (
    name.startsWith("mcp_") ||
    name.startsWith("google_drive_") ||
    name.startsWith("gmail_") ||
    name.startsWith("google_calendar_")
  ) {
    return "external-dispatch";
  }
  return null;
}

export function isProtectedToolCapability(
  capability: ToolCapability,
): boolean {
  return capability !== "none";
}

/** Fail at runtime if a future server schema bypasses the capability catalog. */
export function assertServerToolCapabilities(tools: readonly unknown[]): void {
  const missing = tools
    .map(schemaName)
    .filter((name): name is string => name !== null)
    .filter((name) => toolCapabilityFor(name) === null);
  if (missing.length > 0) {
    throw new Error(
      `Server tools missing capability metadata: ${[...new Set(missing)].sort().join(", ")}`,
    );
  }
}

/**
 * Shared dispatcher boundary for every protected capability. Provider-key
 * disclosure has no user-consent path today, so it is denied by default even
 * when the general current-turn resource context remains authorized.
 */
export async function runToolAuthorizationBoundary(
  capability: ToolCapability,
  authorizeCurrentContext: () => Promise<boolean>,
): Promise<boolean> {
  if (capability === "none") return true;
  if (capability === "provider-disclosure") return false;
  return authorizeCurrentContext();
}
