import http from "node:http";
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock("dns/promises", () => ({ default: { lookup: lookupMock } }));

import { guardedOutboundFetch, validateOutboundUrl } from "../outboundHttp";

function resolvesTo(...addresses: string[]) {
    lookupMock.mockResolvedValue(
        addresses.map((address) => ({
            address,
            family: address.includes(":") ? 6 : 4,
        })),
    );
}

async function listen(
    handler: http.RequestListener,
): Promise<{ server: http.Server; origin: string }> {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no listener");
    return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function close(server: http.Server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
}

beforeEach(() => {
    lookupMock.mockReset();
    lookupMock.mockImplementation(async (hostname: string) =>
        net.isIP(hostname)
            ? [{ address: hostname, family: net.isIP(hostname) }]
            : [{ address: "93.184.216.34", family: 4 }],
    );
});
afterEach(() => vi.restoreAllMocks());

describe("outbound endpoint policy", () => {
    it("accepts HTTPS to a public address and rejects unsafe URL forms", async () => {
        resolvesTo("93.184.216.34");
        await expect(
            validateOutboundUrl("https://public.example.test/v1"),
        ).resolves.toBe("https://public.example.test/v1");

        for (const url of [
            "ftp://public.example.test/model",
            "http://public.example.test/model",
            "https://user:secret@public.example.test/model",
            "https://[::ffff:127.0.0.1]/model",
            "https://2130706433/model",
            "https://0x7f000001/model",
            "https://0177.0.0.1/model",
            "https://169.254.169.254/latest/meta-data",
            "https://metadata.google.internal/computeMetadata/v1",
        ]) {
            await expect(validateOutboundUrl(url), url).rejects.toThrow();
        }
    });

    it("allows an explicitly configured loopback model origin only", async () => {
        const origin = "http://127.0.0.1:11434";
        resolvesTo("127.0.0.1");
        await expect(
            validateOutboundUrl(`${origin}/v1/chat/completions`, {
                allowedLoopbackOrigins: [origin],
            }),
        ).resolves.toBe(`${origin}/v1/chat/completions`);
        await expect(
            validateOutboundUrl("http://127.0.0.1:11435/v1", {
                allowedLoopbackOrigins: [origin],
            }),
        ).rejects.toThrow();
    });

    it("requires an exact allowlisted origin for an on-prem private endpoint", async () => {
        resolvesTo("10.42.0.8");
        await expect(
            validateOutboundUrl("https://model.lan.example/v1"),
        ).rejects.toThrow();
        await expect(
            validateOutboundUrl("https://model.lan.example/v1", {
                allowedPrivateOrigins: ["https://model.lan.example"],
            }),
        ).resolves.toBe("https://model.lan.example/v1");
        await expect(
            validateOutboundUrl("https://metadata.google.internal/v1", {
                allowedPrivateOrigins: ["https://metadata.google.internal"],
            }),
        ).rejects.toThrow();
    });

    it("rechecks DNS at connect time and does not reach a rebound private IP", async () => {
        let requests = 0;
        const local = await listen((_req, res) => {
            requests += 1;
            res.end("unexpected");
        });
        try {
            lookupMock
                .mockResolvedValueOnce([
                    { address: "93.184.216.34", family: 4 },
                ])
                .mockResolvedValueOnce([
                    { address: "127.0.0.1", family: 4 },
                ]);
            await expect(
                guardedOutboundFetch(
                    `http://rebind.example.test:${new URL(local.origin).port}/`,
                    {},
                    { totalTimeoutMs: 500 },
                ),
            ).rejects.toThrow();
            expect(requests).toBe(0);
        } finally {
            await close(local.server);
        }
    });

    it("allows the intended local-model control request", async () => {
        const local = await listen((_req, res) => {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: true }));
        });
        try {
            const response = await guardedOutboundFetch(
                `${local.origin}/v1/models`,
                {},
                {
                    allowedLoopbackOrigins: [local.origin],
                    totalTimeoutMs: 1_000,
                },
            );
            await expect(response.json()).resolves.toEqual({ ok: true });
        } finally {
            await close(local.server);
        }
    });

    it("does not follow redirects, bounds response size, and times out a hanging peer", async () => {
        let redirectedRequests = 0;
        const second = await listen((_req, res) => {
            redirectedRequests += 1;
            res.end("redirected");
        });
        const redirect = await listen((_req, res) => {
            res.statusCode = 302;
            res.setHeader("location", `${second.origin}/private`);
            res.end();
        });
        const huge = await listen((_req, res) => res.end("x".repeat(100)));
        const hanging = await listen(() => {});
        const loopbacks = [second.origin, redirect.origin, huge.origin, hanging.origin];
        try {
            await expect(
                guardedOutboundFetch(`${redirect.origin}/start`, {}, {
                    allowedLoopbackOrigins: loopbacks,
                    totalTimeoutMs: 500,
                }),
            ).rejects.toThrow();
            expect(redirectedRequests).toBe(0);

            await expect(
                guardedOutboundFetch(`${huge.origin}/`, {}, {
                    allowedLoopbackOrigins: loopbacks,
                    maxResponseBytes: 10,
                    totalTimeoutMs: 500,
                }),
            ).rejects.toThrow(/size limit/);

            await expect(
                guardedOutboundFetch(`${hanging.origin}/`, {}, {
                    allowedLoopbackOrigins: loopbacks,
                    totalTimeoutMs: 100,
                    idleTimeoutMs: 100,
                }),
            ).rejects.toThrow();
        } finally {
            await Promise.all([
                close(second.server),
                close(redirect.server),
                close(huge.server),
                close(hanging.server),
            ]);
        }
    });
});
