const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

/**
 * A DOCX relationship is document content, not a trusted application link.
 * Resolve relative targets against the preview's current application URL and
 * allow only browser navigation schemes that are safe for ordinary links.
 */
export function isSafeDocxLinkTarget(target: string, baseUrl: string): boolean {
    try {
        const resolved = new URL(target, baseUrl);
        return SAFE_LINK_PROTOCOLS.has(resolved.protocol.toLowerCase());
    } catch {
        return false;
    }
}

/** Remove unsafe HTML and SVG hyperlink targets produced by docx-preview. */
export function sanitizeDocxLinks(
    container: ParentNode,
    baseUrl: string,
): void {
    for (const anchor of container.querySelectorAll("a")) {
        const href = anchor.getAttribute("href");
        if (href !== null && !isSafeDocxLinkTarget(href, baseUrl)) {
            anchor.removeAttribute("href");
        }

        const xlinkHref = anchor.getAttribute("xlink:href");
        if (
            xlinkHref !== null &&
            !isSafeDocxLinkTarget(xlinkHref, baseUrl)
        ) {
            anchor.removeAttribute("xlink:href");
        }
    }
}
