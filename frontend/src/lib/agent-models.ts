import type { AgentModel } from "@/services/api/agent";

/**
 * The editor's side of the agent's model list.
 *
 * The list itself is AlayaCore's: `model.conf`, announced by the agent as `SM model_list` and written by
 * `:model_sync`. A canvas edits it through that command, which takes the **whole** list — so what a page
 * sends is "these models, in this order", and a model that is missing is a model that is deleted.
 *
 * What a page cannot send is the part it has never been shown: `SM model_list` carries every `api_key` in
 * cleartext; the server strips them (`agent.Model`), and puts them back into the list a canvas edited
 * before AlayaCore sees it (`agent.Sessions.ModelSync`). So an existing model travels by id and the fields
 * on this screen, and a key travels only when this page has one to give: a model being created, or one
 * whose key the user has just retyped. An empty key field says nothing and changes nothing.
 *
 * Everything else in an entry is on the form (#249): the token caps, the three reasoning blocks as the JSON
 * they are, the response field that carries reasoning text, and whether a step's tool calls run one at a
 * time. The reasoning blocks are the one place where a blank field is an answer — a form showed the value,
 * so clearing the box removes the block, which is sent as `null`.
 */
export type ModelProtocol = "openai" | "anthropic";

/** The fields a model is added or changed with. Numbers stay text so a half-typed one is not a `NaN`. */
export type ModelDraft = {
    name: string;
    modelId: string;
    baseUrl: string;
    protocol: ModelProtocol;
    apiKey: string;
    /** Context window; "" is the same as 0, which `model.conf` reads as unlimited. */
    contextLimit: string;
    /** Output cap; "" is the provider's own default. */
    maxTokens: string;
    /** The three reasoning blocks as JSON text: "" is no block, and clearing one removes it. */
    reasoning0: string;
    reasoning1: string;
    reasoning2: string;
    /** The response key that carries reasoning text; "" leaves the provider's default. */
    reasoningField: string;
    serialToolCalls: boolean;
};

/** One entry of the array `:model_sync` takes, in the protocol's own field names. */
type SyncModel = {
    id?: number;
    name: string;
    protocol_type: ModelProtocol;
    base_url: string;
    model_name: string;
    context_limit?: number;
    max_tokens?: number;
    reasoning_0?: unknown;
    reasoning_1?: unknown;
    reasoning_2?: unknown;
    reasoning_field?: string;
    serial_tool_calls?: boolean;
    api_key?: string;
};

export const emptyModelDraft: ModelDraft = {
    name: "",
    modelId: "",
    baseUrl: "",
    protocol: "openai",
    apiKey: "",
    contextLimit: "",
    maxTokens: "",
    reasoning0: "",
    reasoning1: "",
    reasoning2: "",
    reasoningField: "",
    serialToolCalls: false,
};

/** What one model on screen looks like in the form. The key is not known here, so it starts empty. */
export function modelDraftOf(model: AgentModel): ModelDraft {
    return {
        name: model.name,
        modelId: model.modelName ?? "",
        baseUrl: model.baseUrl ?? "",
        protocol: protocolOf(model.protocolType),
        apiKey: "",
        contextLimit: model.contextLimit ? String(model.contextLimit) : "",
        maxTokens: model.maxTokens ? String(model.maxTokens) : "",
        reasoning0: reasoningText(model.reasoning0),
        reasoning1: reasoningText(model.reasoning1),
        reasoning2: reasoningText(model.reasoning2),
        reasoningField: model.reasoningField ?? "",
        serialToolCalls: model.serialToolCalls === true,
    };
}

/** The JSON a form shows for a block the agent holds, indented for reading; "" when there is none. */
function reasoningText(value: unknown): string {
    if (value === undefined || value === null) return "";
    return JSON.stringify(value, null, 2);
}

/**
 * "" when a block's text is blank or a JSON object, and the translation key of the reason when it is not.
 *
 * The blocks are merged into a request body as they stand, so a string, a number or an array would be a
 * request AlayaCore sends malformed. The server refuses them too (`internal/agent`); this is the same rule
 * where it can be said while the user is typing.
 */
export function reasoningError(text: string): string {
    if (!text.trim()) return "";
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return "config.preferences.modelReasoningNotJson";
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return "config.preferences.modelReasoningNotObject";
    }
    return "";
}

/** The three blocks of a draft, in the order they are shown, with the key each error is rendered under. */
const reasoningFieldsOf = (draft: ModelDraft): Array<{ label: string; text: string }> => [
    { label: "modelReasoning0", text: draft.reasoning0 },
    { label: "modelReasoning1", text: draft.reasoning1 },
    { label: "modelReasoning2", text: draft.reasoning2 },
];

/** The first thing wrong with one of the blocks, as a translation key, or "". */
function draftReasoningError(draft: ModelDraft): string {
    for (const field of reasoningFieldsOf(draft)) {
        const error = reasoningError(field.text);
        if (error) return error;
    }
    return "";
}

/** Whether a draft says enough to be a model: a name to show, the two things a request needs, and JSON that parses. */
export function modelDraftComplete(draft: ModelDraft): boolean {
    return Boolean(draft.name.trim() && draft.modelId.trim() && draft.baseUrl.trim()) && !draftReasoningError(draft);
}

/** What one edit does to the list: a model added after the others, or one changed or removed where it is. */
export type ModelChange = { kind: "add"; draft: ModelDraft } | { kind: "edit"; id: number; draft: ModelDraft } | { kind: "delete"; id: number };

/**
 * The list to send: every model on screen, with one added, changed or removed.
 *
 * No change at all is also a delete, of everything: the list is the file, so what is not in it is gone.
 */
export function modelSyncPayload(models: AgentModel[], change?: ModelChange): string {
    const kept = models.map((model) => entryOf(model));
    if (!change) return JSON.stringify(kept);
    switch (change.kind) {
        case "add":
            return JSON.stringify([...kept, editableOf(change.draft)]);
        case "edit":
            return JSON.stringify(kept.map((entry) => (entry.id === change.id ? { ...entry, ...editableOf(change.draft) } : entry)));
        case "delete":
            return JSON.stringify(kept.filter((entry) => entry.id !== change.id));
    }
}

/** One model the agent announced, as this page may describe it back: only what a form would show unchanged. */
function entryOf(model: AgentModel): SyncModel {
    return {
        id: model.id,
        name: model.name,
        protocol_type: protocolOf(model.protocolType),
        base_url: model.baseUrl ?? "",
        model_name: model.modelName ?? "",
    };
}

/** The fields the form owns. The key is one of them only when there is one to send. */
function editableOf(draft: ModelDraft): Omit<SyncModel, "id"> {
    const entry: Omit<SyncModel, "id"> = {
        name: draft.name.trim(),
        protocol_type: draft.protocol,
        base_url: draft.baseUrl.trim(),
        model_name: draft.modelId.trim(),
        context_limit: count(draft.contextLimit),
        max_tokens: count(draft.maxTokens),
        // `null` is an answer — the box was cleared — and absent is not (`entryOf` sends no blocks at all).
        reasoning_0: reasoningValue(draft.reasoning0),
        reasoning_1: reasoningValue(draft.reasoning1),
        reasoning_2: reasoningValue(draft.reasoning2),
        serial_tool_calls: draft.serialToolCalls,
    };
    // A field left empty says nothing rather than "no field": the provider's default is the absence.
    const reasoningField = draft.reasoningField.trim();
    if (reasoningField) entry.reasoning_field = reasoningField;
    // An empty key is no answer, not an empty key: the field is how a stored key is kept.
    const key = draft.apiKey.trim();
    if (key) entry.api_key = key;
    return entry;
}

/** A count as typed, or 0 — which is what `model.conf` writes for "not set". */
function count(text: string): number {
    const value = Number(text.trim());
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/** A reasoning block as JSON, or `null` for a cleared one. `modelDraftComplete` has already checked it parses. */
function reasoningValue(text: string): unknown {
    return text.trim() ? JSON.parse(text) : null;
}

/** The protocol, by the two names AlayaCore knows. Anything else is the one every provider speaks. */
function protocolOf(protocol: string | undefined): ModelProtocol {
    return protocol === "anthropic" ? "anthropic" : "openai";
}
