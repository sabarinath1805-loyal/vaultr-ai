import { describe, expect, it } from "vitest";
import { createContentSecurityPolicy } from "./contentSecurityPolicy";

describe("frontend Content Security Policy", () => {
    it("limits production resource destinations to self and an explicitly configured Sentry origin", () => {
        const policy = createContentSecurityPolicy("testNonceValue0123456789==", {
            sentryDsn: "https://synthetic@telemetry.example/42",
            storageEndpoint: "http://localhost:9000/bucket",
        });

        expect(policy).toContain("script-src 'self' 'nonce-testNonceValue0123456789==' 'strict-dynamic'");
        expect(policy).toContain("style-src 'self' 'nonce-testNonceValue0123456789=='");
        expect(policy).toContain("img-src 'self' data: blob:");
        expect(policy).toContain("font-src 'self'");
        expect(policy).toContain("connect-src 'self' https://telemetry.example http://localhost:9000");
        expect(policy).toContain("frame-ancestors 'none'");
        expect(policy).not.toContain("*");
        expect(policy).not.toContain("unsafe-eval");
    });

    it("has no external connection endpoint when telemetry is unset and restricts unsafe-eval to development", () => {
        const production = createContentSecurityPolicy("testNonceValue0123456789==");
        expect(production).toContain("connect-src 'self'");
        expect(production).not.toContain("telemetry.example");
        expect(production).not.toContain("unsafe-eval");

        const development = createContentSecurityPolicy("testNonceValue0123456789==", { development: true });
        expect(development).toContain("'unsafe-eval'");
        expect(development).toContain("ws://localhost:3000");
        expect(development).toContain("ws://127.0.0.1:3000");
    });

    it("rejects a nonce that could break out of a CSP directive", () => {
        expect(() => createContentSecurityPolicy("unsafe; connect-src *")).toThrow("CSP nonce");
    });
});
