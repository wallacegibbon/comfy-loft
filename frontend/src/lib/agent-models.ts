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
 * before AlayaCore sees it (`agent.Sessions.ModelSync`). So an existing model travels by id and the four
 * fields on this screen, and a key travels only when this page has one to give: a model being created, or
 * one whose key the user has just retyped. An empty key field says nothing and changes nothing.
 */
export type ModelProtocol = "openai" | "anthropic";

/** The fields a model is added or changed with. */
export type ModelDraft = {
    name: string;
    modelId: string;
    baseUrl: string;
    protocol: ModelProtocol;
    apiKey: string;
};

/** One entry of the array `:model_sync` takes, in the protocol's own field names. */
type SyncModel = {
    id?: number;
    name: string;
    protocol_type: ModelProtocol;
    base_url: string;
    model_name: string;
    api_key?: string;
};

export const emptyModelDraft: ModelDraft = { name: "", modelId: "", baseUrl: "", protocol: "openai", apiKey: "" };

/** What one model on screen looks like in the form. The key is not known here, so it starts empty. */
export function modelDraftOf(model: AgentModel): ModelDraft {
    return {
        name: model.name,
        modelId: model.modelName ?? "",
        baseUrl: model.baseUrl ?? "",
        protocol: protocolOf(model.protocolType),
        apiKey: "",
    };
}

/** Whether a draft says enough to be a model: a name to show, and the two things a request needs. */
export function modelDraftComplete(draft: ModelDraft): boolean {
    return Boolean(draft.name.trim() && draft.modelId.trim() && draft.baseUrl.trim());
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

/** One model the agent announced, as this page may describe it back. */
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
    };
    // An empty key is no answer, not an empty key: the field is how a stored key is kept.
    const key = draft.apiKey.trim();
    if (key) entry.api_key = key;
    return entry;
}

/** The protocol, by the two names AlayaCore knows. Anything else is the one every provider speaks. */
function protocolOf(protocol: string | undefined): ModelProtocol {
    return protocol === "anthropic" ? "anthropic" : "openai";
}
