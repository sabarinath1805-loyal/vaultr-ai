import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createContentSecurityPolicy } from "@/shared/lib/contentSecurityPolicy";

export function proxy(request: NextRequest) {
    const nonce = randomBytes(18).toString("base64");
    const policy = createContentSecurityPolicy(nonce, {
        sentryDsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
        storageEndpoint: process.env.R2_PUBLIC_ENDPOINT_URL,
        development: process.env.NODE_ENV === "development",
    });
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-nonce", nonce);
    requestHeaders.set("Content-Security-Policy", policy);

    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set("Content-Security-Policy", policy);
    return response;
}

export const config = {
    matcher: [
        {
            source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
            missing: [
                { type: "header", key: "next-router-prefetch" },
                { type: "header", key: "purpose", value: "prefetch" },
            ],
        },
    ],
};
