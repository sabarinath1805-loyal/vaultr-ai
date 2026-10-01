import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { diagnosticRoute } from "./sentryPrivacy";

/**
 * The redaction core is one privacy control mirrored into two files: the
 * backend cannot import the frontend tree at build time, so it carries a
 * copy. This test is what keeps them one control: it fails the moment the
 * marked block differs, ignoring indentation (2 vs 4 spaces).
 */
const SHARED = path.resolve(__dirname, "sentryEvent.ts");
const BACKEND = path.resolve(
    __dirname,
    "../../../../backend/src/lib/observability/sentry.ts",
);

function sharedBlock(file: string): string {
    const source = readFileSync(file, "utf8");
    const match = source.match(
        /\/\/ BEGIN shared-redaction[\s\S]*?\/\/ END shared-redaction/,
    );
    if (!match) throw new Error(`no shared-redaction block in ${file}`);
    return match[0]
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join("\n");
}

describe("shared-redaction block", () => {
    it("keeps the outbound envelope privacy boundary identical", () => {
        expect(readFileSync(path.resolve(__dirname, "sentryPrivacy.ts"), "utf8"))
            .toBe(readFileSync(path.resolve(__dirname, "../../../../backend/src/lib/observability/sentryPrivacy.ts"), "utf8"));
    });
    it("is identical in the backend and the shared scrubber", () => {
        expect(sharedBlock(BACKEND)).toBe(sharedBlock(SHARED));
    });
});


it('retains the fixed vocabulary of every Express mount without parameter names', () => {
    const app = readFileSync(path.resolve(__dirname, '../../../../backend/src/app.ts'), 'utf8');
    const routes: string[] = [];
    const directCalls = [...app.matchAll(/app\.(?:use|get|post|put|patch|delete)\s*\(\s*(?:"([^"]+)"|'([^']+)'|\[([\s\S]*?)\])/g)];
    for (const match of directCalls) {
        const value = match[1] ?? match[2];
        if (value) routes.push(value);
        else if (match[3]) routes.push(...[...match[3].matchAll(/["']([^"']+)["']/g)].map(item => item[1]!));
    }
    const mountTable = app.match(/export const routeMounts[\s\S]*?\n\];/)?.[0] ?? '';
    for (const match of mountTable.matchAll(/path:\s*(?:"([^"]+)"|'([^']+)'|\[([^\]]*)\])/g)) {
        const value = match[1] ?? match[2];
        if (value) routes.push(value);
        else if (match[3]) routes.push(...[...match[3].matchAll(/["']([^"']+)["']/g)].map(item => item[1]!));
    }
    const constants = [...app.matchAll(/const\s+\w*(?:PATH|ROUTE)\s*=\s*["']([^"']+)["']/g)].map(match => match[1]!);
    routes.push(...constants);
    expect(routes.length).toBeGreaterThan(20);
    for (const route of routes) {
        expect(diagnosticRoute(route)).toBe(route.replace(/:[^/]+/g, ':id'));
    }
});
