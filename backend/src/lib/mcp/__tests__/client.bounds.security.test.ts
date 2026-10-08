import http from "node:http";
import { describe, expect, it } from "vitest";
import { guardedFetch } from "../client";

describe("MCP GET response bounds", () => {
    it("bounds direct and redirected peer responses while preserving normal discovery", async () => {
        const server = http.createServer((req, res) => {
            if (req.url === "/redirect") {
                res.writeHead(302, { location: "/large" });
                res.end();
            } else if (req.url === "/large") {
                res.end("x".repeat(100));
            } else if (req.url === "/chunked") {
                res.writeHead(200, { "transfer-encoding": "chunked" });
                res.write("x".repeat(50));
                res.end("y".repeat(50));
            } else if (req.url === "/missing-location") {
                res.writeHead(302, { "content-length": "100" });
                res.end("x".repeat(100));
            } else if (req.url === "/invalid-location") {
                res.writeHead(302, { location: "https://[", "content-length": "100" });
                res.end("x".repeat(100));
            } else {
                res.setHeader("content-type", "application/json");
                res.end('{"ok":true}');
            }
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("missing listener");
        const origin = `http://127.0.0.1:${address.port}`;
        const policy = {
            allowedLoopbackOrigins: [origin],
            maxResponseBytes: 20,
            totalTimeoutMs: 1_000,
        };
        try {
            const normal = await guardedFetch(`${origin}/normal`, {}, policy);
            await expect(normal.json()).resolves.toEqual({ ok: true });
            for (const path of ["/large", "/redirect", "/chunked", "/missing-location", "/invalid-location"]) {
                await expect((async () => {
                    const response = await guardedFetch(`${origin}${path}`, {}, policy);
                    return response.text();
                })(), path).rejects.toThrow(/size limit/);
            }
        } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
});
