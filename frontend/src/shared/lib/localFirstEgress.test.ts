import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { STANDARD_FONT_DATA_URL } from "@/app/components/shared/views/highlightQuote";

const frontendRoot = path.resolve(__dirname, "../../../");
const resourceTags = /<(script|link|img|source|video|audio)\b[^>]*>/gi;
const cssRemoteLoad = /(?:@import\s+(?:url\(\s*)?|url\(\s*)["']?(https?:\/\/[^\s"')]+)/gi;

function remoteLoads(source: string, file: string): string[] {
    const failures: string[] = [];
    for (const match of source.matchAll(resourceTags)) {
        const tag = match[0];
        const tagName = match[1]?.toLowerCase();
        const attrPattern = /\b(src|href|poster|srcset|imagesrcset)\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
        for (const attr of tag.matchAll(attrPattern)) {
            const name = attr[1]?.toLowerCase();
            if (tagName === "link" && name === "href") {
                const rel = tag.match(/\brel\s*=\s*(?:"([^"]+)"|'([^']+)')/i);
                const relation = (rel?.[1] ?? rel?.[2] ?? "").toLowerCase();
                if (!/stylesheet|preload|modulepreload|icon|manifest|preconnect|dns-prefetch/.test(relation)) continue;
            }
            const raw = attr[2] ?? attr[3];
            if (raw && /^https?:\/\//i.test(raw)) failures.push(`${file}: ${tagName}[${name}] ${raw}`);
        }
    }
    if (/\.css$/i.test(file)) {
        for (const match of source.matchAll(cssRemoteLoad)) failures.push(`${file}: CSS ${match[1]}`);
    } else {
        const cssImport = /@import\s+(?:url\(\s*)?["']?(https?:\/\/[^\s"')]+)/gi;
        for (const match of source.matchAll(cssImport)) failures.push(`${file}: CSS ${match[1]}`);
    }
    return failures;
}

function filesUnder(root: string, accept: (file: string) => boolean): string[] {
    if (!existsSync(root)) return [];
    const output: string[] = [];
    for (const entry of readdirSync(root)) {
        const full = path.join(root, entry);
        if (statSync(full).isDirectory()) output.push(...filesUnder(full, accept));
        else if (accept(full)) output.push(full);
    }
    return output;
}

describe("local-first frontend egress", () => {
    it("contains no external script, stylesheet, font, image, or media loads in source or build output", () => {
        const sourceFiles = filesUnder(path.join(frontendRoot, "src"), (file) =>
            /\.(?:tsx?|jsx?|css|html)$/.test(file) && !/\.(?:test|spec)\.[^/]+$/.test(file),
        );
        const publicFiles = filesUnder(path.join(frontendRoot, "public"), (file) =>
            /\.(?:css|html)$/.test(file),
        );
        const builtFiles = filesUnder(path.join(frontendRoot, ".next"), (file) =>
            /\.(?:html?|css)$/.test(file),
        );
        const failures = [...sourceFiles, ...publicFiles, ...builtFiles].flatMap((file) =>
            remoteLoads(readFileSync(file, "utf8"), path.relative(frontendRoot, file)),
        );
        expect(failures).toEqual([]);
    });

    it("resolves PDF.js standard fonts from bundled local assets", () => {
        expect(STANDARD_FONT_DATA_URL).toBe("/pdfjs-standard-fonts/");
        expect(existsSync(path.join(frontendRoot, "public", "pdfjs-standard-fonts", "LiberationSans-Regular.ttf"))).toBe(true);
        expect(existsSync(path.join(frontendRoot, "public", "pdfjs-standard-fonts", "LICENSE_LIBERATION"))).toBe(true);
        expect(existsSync(path.join(frontendRoot, "public", "pdfjs-standard-fonts", "LICENSE_FOXIT"))).toBe(true);
    });
});
