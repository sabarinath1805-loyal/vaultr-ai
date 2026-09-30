import { describe, expect, it, vi } from "vitest";
import {
  assertServerToolCapabilities,
  isProtectedToolCapability,
  REGISTERED_SERVER_TOOL_NAMES,
  REGISTERED_SERVER_TOOL_SCHEMAS,
  SERVER_TOOL_CAPABILITIES,
  toolCapabilityFor,
  runToolAuthorizationBoundary,
} from "./toolCapabilities";

describe("server tool capability catalog", () => {
  it("covers every registered built-in server tool", () => {
    expect(Object.keys(SERVER_TOOL_CAPABILITIES).sort()).toEqual(
      [...REGISTERED_SERVER_TOOL_NAMES].sort(),
    );
    expect(() =>
      assertServerToolCapabilities(REGISTERED_SERVER_TOOL_SCHEMAS),
    ).not.toThrow();
    for (const name of REGISTERED_SERVER_TOOL_NAMES) {
      expect(toolCapabilityFor(name), name).not.toBeNull();
    }
  });

  it("requires future static schemas to declare metadata before they can be advertised", () => {
    expect(() =>
      assertServerToolCapabilities([
        { type: "function", function: { name: "future_sensitive_tool" } },
      ]),
    ).toThrow(/future_sensitive_tool/);
  });

  it("classifies connector and CourtListener dispatch as protected external work", () => {
    for (const name of [
      "mcp_abc_read_file",
      "google_drive_read_file",
      "gmail_get_message",
      "google_calendar_list_events",
      "courtlistener_search_case_law",
    ]) {
      const capability = toolCapabilityFor(name);
      expect(capability).toBe("external-dispatch");
      expect(isProtectedToolCapability(capability!)).toBe(true);
    }
    expect(toolCapabilityFor("unknown_server_tool")).toBeNull();
  });

  it("sends every protected capability through the shared authorization boundary", async () => {
    const authorize = vi.fn(async () => true);
    for (const capability of [
      "read",
      "write",
      "external-dispatch",
    ] as const) {
      await expect(
        runToolAuthorizationBoundary(capability, authorize),
      ).resolves.toBe(true);
    }
    expect(authorize).toHaveBeenCalledTimes(3);

    await expect(
      runToolAuthorizationBoundary("provider-disclosure", authorize),
    ).resolves.toBe(false);
    expect(authorize).toHaveBeenCalledTimes(3);

    await expect(runToolAuthorizationBoundary("none", authorize)).resolves.toBe(
      true,
    );
    expect(authorize).toHaveBeenCalledTimes(3);
  });
});
