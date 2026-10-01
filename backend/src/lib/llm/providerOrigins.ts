/** Keep this shared-kernel type local: lib must not depend on modules. */
export type UserApiKeyProvider =
    | "claude"
    | "gemini"
    | "openai"
    | "openrouter"
    | "vercel"
    | "opencode-go"
    | "courtlistener";

const DEFAULT_BASES: Record<UserApiKeyProvider, string> = {
    claude: "https://api.anthropic.com",
    gemini: "https://generativelanguage.googleapis.com",
    openai: "https://api.openai.com",
    openrouter: "https://openrouter.ai/api/v1",
    vercel: "https://ai-gateway.vercel.sh/v1",
    "opencode-go": "https://opencode.ai/zen/go/v1",
    courtlistener: "https://www.courtlistener.com",
};

function effectiveBase(provider: UserApiKeyProvider): string {
    switch (provider) {
        case "openrouter":
            return process.env.OPENROUTER_BASE_URL?.trim() || DEFAULT_BASES[provider];
        case "vercel":
            return process.env.VERCEL_AI_GATEWAY_BASE_URL?.trim() || DEFAULT_BASES[provider];
        case "opencode-go":
            return process.env.OPENCODE_GO_BASE_URL?.trim() || DEFAULT_BASES[provider];
        default:
            return DEFAULT_BASES[provider];
    }
}

export function normalizedOrigin(value: string): string | null {
    try {
        const url = new URL(value);
        if (
            (url.protocol !== "http:" && url.protocol !== "https:") ||
            !url.hostname ||
            url.username ||
            url.password
        ) {
            return null;
        }
        return url.origin;
    } catch {
        return null;
    }
}

/** Host binding for user-held provider credentials. Path changes do not move a key to another host. */
export function userApiKeyOrigin(provider: UserApiKeyProvider): string {
    return normalizedOrigin(effectiveBase(provider)) ?? DEFAULT_BASES[provider];
}

/** Exact origins on which the operator has explicitly configured a private model endpoint. */
export function configuredPrivateEndpointOrigins(): string[] {
    const origins = (process.env.MODEL_PRIVATE_ENDPOINT_ALLOWLIST ?? "")
        .split(",")
        .map((item) => normalizedOrigin(item.trim()))
        .filter((origin): origin is string => origin !== null);
    // Compose's default host.docker.internal mapping is the explicit local
    // Ollama endpoint for the bundled self-hosted deployment. Other private
    // model endpoints require MODEL_PRIVATE_ENDPOINT_ALLOWLIST.
    const ollama = normalizedOrigin(
        process.env.OLLAMA_BASE_URL?.trim() ||
            "http://localhost:11434/v1",
    );
    if (ollama && new URL(ollama).hostname.toLowerCase() === "host.docker.internal") {
        origins.push(ollama);
    }
    return [...new Set(origins)];
}

/** Loopback is available only for explicitly configured local model endpoints. */
export function configuredLoopbackModelOrigins(): string[] {
    const values = [process.env.OLLAMA_BASE_URL?.trim() || "http://localhost:11434/v1"];
    try {
        const registry = JSON.parse(process.env.MIKE_MODEL_CONFIG_JSON ?? "{}");
        if (Array.isArray(registry?.models)) {
            for (const model of registry.models) {
                if (model?.location === "local" && typeof model.baseUrl === "string") {
                    values.push(model.baseUrl);
                }
            }
        }
    } catch {
        // The model registry reports malformed JSON at its ordinary load boundary.
    }
    const origins = new Set<string>();
    for (const value of values) {
        const origin = normalizedOrigin(value);
        if (!origin) continue;
        const url = new URL(origin);
        const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
        if (host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "::1") {
            origins.add(origin);
        }
    }
    return [...origins];
}
