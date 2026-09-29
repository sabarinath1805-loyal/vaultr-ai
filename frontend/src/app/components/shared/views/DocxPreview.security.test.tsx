import {
    Document,
    ExternalHyperlink,
    Footer,
    Header,
    Packer,
    Paragraph,
    Table,
    TableCell,
    TableRow,
    TextRun,
} from "docx";
import { renderAsync } from "docx-preview";
import { expect, it } from "vitest";
import {
    isSafeDocxLinkTarget,
    sanitizeDocxLinks,
} from "./docxLinkSecurity";

function link(target: string, label: string) {
    return new ExternalHyperlink({
        link: target,
        children: [new TextRun(label)],
    });
}

it("sanitizes hyperlink relationships across the rendered DOCX document tree", async () => {
    const bytes = await Packer.toBuffer(
        new Document({
            sections: [
                {
                    headers: {
                        default: new Header({
                            children: [
                                new Paragraph({
                                    children: [
                                        link(
                                            "javascript:window.__docx_probe=1",
                                            "header attack",
                                        ),
                                    ],
                                }),
                            ],
                        }),
                    },
                    footers: {
                        default: new Footer({
                            children: [
                                new Paragraph({
                                    children: [
                                        link(
                                            "https://example.test/footer",
                                            "footer safe",
                                        ),
                                    ],
                                }),
                            ],
                        }),
                    },
                    children: [
                        new Paragraph({
                            children: [
                                link(
                                    "JaVaScRiPt:window.__docx_probe=2",
                                    "body attack",
                                ),
                                link(
                                    "https://example.test/legal",
                                    "body safe",
                                ),
                                link(
                                    "mailto:legal@example.test",
                                    "mail safe",
                                ),
                            ],
                        }),
                        new Table({
                            rows: [
                                new TableRow({
                                    children: [
                                        new TableCell({
                                            children: [
                                                new Paragraph({
                                                    children: [
                                                        link(
                                                            "data:text/html,unsafe",
                                                            "table attack",
                                                        ),
                                                    ],
                                                }),
                                            ],
                                        }),
                                    ],
                                }),
                            ],
                        }),
                    ],
                },
            ],
        }),
    );
    const container = document.createElement("div");
    document.body.append(container);

    await renderAsync(bytes, container, undefined, {
        inWrapper: false,
        ignoreWidth: true,
        ignoreHeight: true,
        experimental: true,
    });

    const links = [...container.querySelectorAll<HTMLAnchorElement>("a")];
    const originalAttack = links.find((anchor) =>
        anchor.textContent?.includes("body attack"),
    );
    expect(originalAttack?.getAttribute("href")).toMatch(/^javascript:/i);
    expect(
        links.some((anchor) => anchor.textContent?.includes("header attack")),
    ).toBe(true);
    expect(
        links.some((anchor) => anchor.textContent?.includes("table attack")),
    ).toBe(true);

    sanitizeDocxLinks(container, "http://127.0.0.1:3000/documents");

    for (const label of ["body attack", "table attack"]) {
        expect(
            links.find((anchor) => anchor.textContent?.includes(label)),
        ).not.toHaveAttribute("href");
    }
    expect(
        links.find((anchor) => anchor.textContent?.includes("body safe")),
    ).toHaveAttribute("href", "https://example.test/legal");
    expect(
        links.find((anchor) => anchor.textContent?.includes("mail safe")),
    ).toHaveAttribute("href", "mailto:legal@example.test");
    expect(
        links.find((anchor) => anchor.textContent?.includes("footer safe")),
    ).toHaveAttribute("href", "");
    expect(
        links.find((anchor) => anchor.textContent?.includes("header attack")),
    ).toHaveAttribute("href", "");
    expect(
        links
            .filter((anchor) => /header attack|footer safe/.test(anchor.textContent ?? ""))
            .every((anchor) => !anchor.hasAttribute("target") && !anchor.hasAttribute("rel")),
    ).toBe(true);

    container.remove();
});

it("uses URL parsing with an explicit scheme allowlist for edge-case targets", () => {
    const base = "https://vaultr.example.test/documents/current";
    for (const target of [
        "javascript:alert(1)",
        " JaVaScRiPt:alert(1) ",
        "java\t\nscript:alert(1)",
        "vbscript:alert(1)",
        "data:text/html,unsafe",
        "blob:https://vaultr.example.test/unsafe",
        "file:///tmp/unsafe",
        "unknown:unsafe",
        "http://[malformed",
    ]) {
        expect(isSafeDocxLinkTarget(target, base)).toBe(false);
    }

    for (const target of [
        "https://example.test/legal",
        "http://example.test/legal",
        "mailto:legal@example.test",
        "tel:+12025550101",
        "#bookmark",
        "relative/reference",
        "//example.test/reference",
        "jav%61script:relative-safe",
        "jаvascript:unicode-confusable",
        "javascript：fullwidth-colon",
        "r".repeat(16_384),
    ]) {
        expect(isSafeDocxLinkTarget(target, base)).toBe(true);
    }
});
