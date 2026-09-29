import { render, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { authenticatedFetch } from "@/app/lib/authEvents";
import { DocxView } from "./DocxView";

vi.mock("@/app/lib/authEvents", () => ({ authenticatedFetch: vi.fn() }));
vi.mock("@/app/lib/mikeApi", () => ({
    API_BASE: "/api",
    getDocumentFileUrl: () => "/api/document/file",
}));
vi.mock("docx-preview", () => ({
    renderAsync: vi.fn(async (_bytes: ArrayBuffer, container: HTMLElement) => {
        container.innerHTML = `
            <p><a href="javascript:window.__docx_probe=1">script</a></p>
            <p><a href="JaVaScRiPt:window.__docx_probe=2">case</a></p>
            <p><a href="java&#x09;script:window.__docx_probe=3">control</a></p>
            <p><a href="java&#x0a;script:window.__docx_probe=31">newline</a></p>
            <p><a href=" &#x09;javascript:window.__docx_probe=32 ">whitespace</a></p>
            <p><a href="&#x6a;avascript:window.__docx_probe=4">entity</a></p>
            <p><a href="javascrip&#116;:window.__docx_probe=41">entity-scheme</a></p>
            <p><a href="vbscript:window.__docx_probe=5">vbscript</a></p>
            <p><a href="data:text/html,unsafe">data</a></p>
            <p><a href="blob:http://127.0.0.1/unsafe">blob</a></p>
            <p><a href="file:///tmp/unsafe">file</a></p>
            <p><a href="unknown:unsafe">unknown</a></p>
            <p><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="javascript:window.__docx_probe=6">xlink</a></svg></p>
            <p><a href="http://[malformed">malformed</a></p>
            <p><a href="https://example.test/legal">https</a></p>
            <p><a href="http://example.test/legal">http</a></p>
            <p><a href="mailto:legal@example.test">mailto</a></p>
            <p><a href="tel:+12025550101">tel</a></p>
            <p><a href="#bookmark">bookmark</a></p>
            <p><a href="relative/reference">relative</a></p>
            <p><a href="//example.test/reference">protocol-relative</a></p>
            <p><a href="jav%61script:relative-safe">percent-encoded</a></p>
            <p><a href="jаvascript:unicode-confusable">unicode-confusable</a></p>
            <p><a href="javascript：fullwidth-colon">unicode-normalized</a></p>
            <p><a href="long-relative-target">long-relative</a></p>
        `;
    }),
}));

beforeEach(() => {
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            disconnect() {}
        },
    );
    vi.stubGlobal("__docx_probe", undefined);
    vi.mocked(authenticatedFetch).mockImplementation(async (url) =>
        String(url).includes("tracked-change-ids")
            ? Response.json({ ids: [] })
            : new Response(new Uint8Array([1])),
    );
});

it("removes unsafe DOCX hyperlink schemes while preserving safe link classes", async () => {
    const { container } = render(
        <DocxView documentId="synthetic-doc" cacheBytes={false} />,
    );

    await waitFor(() => expect(container.querySelector("a[href]")).not.toBeNull());
    const links = [...container.querySelectorAll<HTMLAnchorElement>("a")];

    for (const label of [
        "script",
        "case",
        "control",
        "newline",
        "whitespace",
        "entity",
        "entity-scheme",
        "vbscript",
        "data",
        "blob",
        "file",
        "unknown",
        "xlink",
        "malformed",
    ]) {
        expect(links.find((link) => link.textContent === label)).not.toHaveAttribute(
            "href",
        );
    }

    for (const label of [
        "https",
        "http",
        "mailto",
        "tel",
        "bookmark",
        "relative",
        "protocol-relative",
        "percent-encoded",
        "unicode-confusable",
        "unicode-normalized",
        "long-relative",
    ]) {
        expect(links.find((link) => link.textContent === label)).toHaveAttribute(
            "href",
        );
    }
});
