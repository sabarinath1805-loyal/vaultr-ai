import { afterEach, describe, expect, it } from "vitest";

import { resetModelRegistryCache } from "../../../lib/llm/registry";
import { missingModelApiKey } from "../tabular.shared";

const originalConfig = process.env.MIKE_MODEL_CONFIG_JSON;

function configure(model: Record<string, unknown>) {
    process.env.MIKE_MODEL_CONFIG_JSON = JSON.stringify({ models: [model] });
    resetModelRegistryCache();
}

afterEach(() => {
    if (originalConfig === undefined) delete process.env.MIKE_MODEL_CONFIG_JSON;
    else process.env.MIKE_MODEL_CONFIG_JSON = originalConfig;
    resetModelRegistryCache();
});

describe("configured tabular model authentication", () => {
    it("allows a cloud endpoint that declares no authentication source", () => {
        configure({
            id: "keyless-cloud",
            provider: "openai-compatible",
            location: "cloud",
            baseUrl: "https://models.example.test/v1",
        });

        expect(missingModelApiKey("keyless-cloud", {})).toBeNull();
    });

    it("does not send a provider key to a different configured endpoint", () => {
        configure({
            id: "user-key-cloud",
            label: "User Key Cloud",
            provider: "openai-compatible",
            location: "cloud",
            baseUrl: "https://models.example.test/v1",
            apiKeyProvider: "openai",
        });

        expect(missingModelApiKey("user-key-cloud", {})).toMatchObject({
            provider: "openai-compatible",
            model: "user-key-cloud",
        });
        expect(
            missingModelApiKey("user-key-cloud", { openai: "user-key" }),
        ).toMatchObject({ provider: "openai-compatible", model: "user-key-cloud" });
    });

    it("allows the key at the provider origin it is bound to", () => {
        configure({
            id: "openai-cloud",
            provider: "openai-compatible",
            location: "cloud",
            baseUrl: "https://api.openai.com/v1",
            apiKeyProvider: "openai",
        });

        expect(missingModelApiKey("openai-cloud", { openai: "user-key" })).toBeNull();
    });
});
