import { describe, expect, it } from "vitest";

/**
 * The list a canvas hands the agent to edit its models.
 *
 * `:model_sync` replaces every model in `model.conf` from what it is given, so this array *is* the file: a
 * model it leaves out is deleted, and a field it does not say is a field the server has to put back from
 * the entry the agent announced. These tests pin the bargain in both directions — what travels for a model
 * that exists (its four visible fields, and a key only when this page has one to give), and what travels
 * for one that is being created (everything, and nothing invented).
 */
const { emptyModelDraft, modelDraftComplete, modelDraftOf, modelSyncPayload } = await import("@/lib/agent-models");

const model = (overrides: Partial<Parameters<typeof modelSyncPayload>[0][number]> = {}) => ({
    id: 1,
    name: "DeepSeek / Flash",
    protocolType: "openai",
    baseUrl: "https://api.deepseek.com",
    modelName: "deepseek-flash",
    contextLimit: 1000000,
    hasKey: true,
    ...overrides,
});

describe("modelSyncPayload", () => {
    it("sends every model on screen, by id, and never a key", () => {
        const payload = JSON.parse(modelSyncPayload([model(), model({ id: 2, name: "Qwen", modelName: "qwen3.8-27b", protocolType: "anthropic" })]));

        expect(payload).toEqual([
            { id: 1, name: "DeepSeek / Flash", protocol_type: "openai", base_url: "https://api.deepseek.com", model_name: "deepseek-flash" },
            { id: 2, name: "Qwen", protocol_type: "anthropic", base_url: "https://api.deepseek.com", model_name: "qwen3.8-27b" },
        ]);
        // The one thing a canvas has never been shown: `hasKey` is on screen, the key is not.
        expect(JSON.stringify(payload)).not.toContain("api_key");
    });

    it("leaves out a model that was deleted, which is the whole of a delete", () => {
        const payload = JSON.parse(modelSyncPayload([model(), model({ id: 2 })], { kind: "delete", id: 2 }));

        expect(payload.map((entry: { id: number }) => entry.id)).toEqual([1]);
    });

    it("adds the draft after the models that are already there, key and all", () => {
        const change = { kind: "add" as const, draft: { name: "  New / Claude ", modelId: " claude-haiku-4 ", baseUrl: " https://api.anthropic.com ", protocol: "anthropic" as const, apiKey: " sk-new " } };
        const payload = JSON.parse(modelSyncPayload([model()], change));

        expect(payload).toHaveLength(2);
        expect(payload[1]).toEqual({ name: "New / Claude", protocol_type: "anthropic", base_url: "https://api.anthropic.com", model_name: "claude-haiku-4", api_key: "sk-new" });
        // A new model has no id: the agent assigns ids when it writes the list.
        expect(payload[1]).not.toHaveProperty("id");
    });

    it("leaves the key out of a new model that has none, rather than sending an empty one", () => {
        const payload = JSON.parse(modelSyncPayload([], { kind: "add", draft: { ...emptyModelDraft, name: "Local", modelId: "qwen", baseUrl: "http://127.0.0.1:9999/v1" } }));

        expect(payload[0]).not.toHaveProperty("api_key");
    });

    it("changes a model in the place it stands, and keeps its id", () => {
        const payload = JSON.parse(modelSyncPayload([model(), model({ id: 2 })], { kind: "edit", id: 2, draft: { ...modelDraftOf(model()), name: "Renamed", apiKey: "" } }));

        expect(payload).toHaveLength(2);
        expect(payload[1]).toMatchObject({ id: 2, name: "Renamed" });
        // An empty key field is how a stored key is kept: nothing is said about it.
        expect(payload[1]).not.toHaveProperty("api_key");
    });

    it("sends a key that was retyped, which is how one is rotated", () => {
        const payload = JSON.parse(modelSyncPayload([model()], { kind: "edit", id: 1, draft: { ...modelDraftOf(model()), apiKey: "sk-rotated" } }));

        expect(payload[0]).toMatchObject({ id: 1, name: "DeepSeek / Flash", api_key: "sk-rotated" });
    });

    it("reads an unknown protocol as the one every provider speaks", () => {
        const payload = JSON.parse(modelSyncPayload([model({ protocolType: undefined })]));

        expect(payload[0].protocol_type).toBe("openai");
    });
});

describe("modelDraftOf", () => {
    it("fills the form from the model, with the key it cannot know left empty", () => {
        expect(modelDraftOf(model({ protocolType: "anthropic" }))).toEqual({ name: "DeepSeek / Flash", modelId: "deepseek-flash", baseUrl: "https://api.deepseek.com", protocol: "anthropic", apiKey: "" });
    });
});

describe("modelDraftComplete", () => {
    it("wants a name to show and the two things a request needs", () => {
        expect(modelDraftComplete({ ...emptyModelDraft, name: "Local", modelId: "qwen", baseUrl: "http://127.0.0.1:9999/v1" })).toBe(true);
        // The key is optional: a local endpoint answers without one.
        expect(modelDraftComplete({ ...emptyModelDraft, name: "Local", modelId: "qwen" })).toBe(false);
        expect(modelDraftComplete({ ...emptyModelDraft, name: "   ", modelId: "qwen", baseUrl: "http://127.0.0.1:9999/v1" })).toBe(false);
    });
});
