type ContentSecurityPolicyOptions = {
    sentryDsn?: string;
    storageEndpoint?: string;
    development?: boolean;
};

function explicitHttpOrigin(value: string | undefined): string | null {
    if (!value?.trim()) return null;
    try {
        const parsed = new URL(value.trim());
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
        return parsed.origin;
    } catch {
        return null;
    }
}

export function createContentSecurityPolicy(
    nonce: string,
    options: ContentSecurityPolicyOptions = {},
): string {
    if (!/^[A-Za-z0-9+/_=-]{16,}$/.test(nonce)) {
        throw new Error("CSP nonce must be a random base64-compatible value");
    }

    const scriptSources = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"];
    if (options.development) scriptSources.push("'unsafe-eval'");

    const connectSources = ["'self'"];
    for (const endpoint of [options.sentryDsn, options.storageEndpoint]) {
        const origin = explicitHttpOrigin(endpoint);
        if (origin && !connectSources.includes(origin)) connectSources.push(origin);
    }
    if (options.development) {
        connectSources.push("ws://localhost:3000", "ws://127.0.0.1:3000", "ws://[::1]:3000");
    }

    return [
        "default-src 'self'",
        `script-src ${scriptSources.join(" ")}`,
        `style-src 'self' 'nonce-${nonce}'`,
        "style-src-attr 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self'",
        `connect-src ${connectSources.join(" ")}`,
        "worker-src 'self' blob:",
        "frame-src 'self' blob:",
        "frame-ancestors 'none'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
    ].join("; ");
}
