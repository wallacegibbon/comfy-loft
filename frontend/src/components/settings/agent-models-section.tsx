import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Pencil, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/kit/button";
import { Tooltip } from "@/components/kit/tooltip";
import { AgentModelDialog } from "@/components/settings/agent-model-dialog";
import { emptyModelDraft, modelDraftOf, modelSyncPayload, type ModelChange, type ModelDraft } from "@/lib/agent-models";
import { agentSession, closeAgentSession, onAgentEvent, openAgentSession, sendAgentMessage, settingsAgent, subscribeAgentSessions } from "@/services/api/agent";
import { apiErrorMessage } from "@/services/api/http";
import { useConfigStore } from "@/stores/use-config-store";

/**
 * The agent's models: what it can be asked to use, and the three things a page may do to that list.
 *
 * The list is not this app's. AlayaCore reads it from `model.conf`, announces it at startup and restates it
 * after every change; a model is added, changed or removed by handing the agent its own `model_sync` command
 * with the list the user is looking at. So there is nothing to save and no Apply button: the file is written
 * as a consequence of the command, and the list on screen is the agent's answer to it.
 *
 * The two edits are dialogs (`agent-model-dialog`) rather than a row of inputs under the list: a model is a
 * small document, and five fields on one line is a form nobody can read.
 */
export function AgentModelsSection() {
    const { t } = useTranslation();
    const config = useConfigStore((state) => state.config);
    const session = useSyncExternalStore(subscribeAgentSessions, () => agentSession(settingsAgent));
    const [editor, setEditor] = useState<{ draft: ModelDraft; id?: number } | null>(null);
    const [error, setError] = useState("");

    const baseUrl = config.baseUrl;

    // The section is the session's lifetime: opened when the window opens, released when it closes. Nothing
    // is kept — `settings` is not a canvas, so there is no conversation file behind it.
    //
    // The dependency is the address alone. `config` is a fresh object on every edit anywhere in the app, and
    // depending on it would close and reopen the agent on the next keystroke somewhere else.
    useEffect(() => {
        let live = true;
        setError("");
        void openAgentSession(config, settingsAgent).catch((cause: unknown) => {
            if (live) setError(apiErrorMessage(cause, t("config.preferences.agentModelsUnavailable")));
        });
        return () => {
            live = false;
            closeAgentSession(settingsAgent);
        };
    }, [baseUrl, t]);

    // A model list is written by a command, and the command answers: a rejection (an entry the agent will
    // not accept, a file it cannot write) is the agent's own sentence, shown as it said it.
    useEffect(
        () =>
            onAgentEvent(settingsAgent, (event) => {
                if (event.type === "command") setError(event.ok ? "" : event.message || t("config.preferences.agentModelsUnavailable"));
                if (event.type === "error") setError(event.message || t("config.preferences.agentModelsUnavailable"));
            }),
        [t],
    );

    const sync = useCallback(
        (change?: ModelChange) => {
            const payload = modelSyncPayload(session.models, change);
            if (!sendAgentMessage(settingsAgent, { command: "model_sync", args: payload })) setError(t("config.preferences.agentModelsUnavailable"));
        },
        [session.models, t],
    );

    const save = (draft: ModelDraft) => {
        sync(editor?.id === undefined ? { kind: "add", draft } : { kind: "edit", id: editor.id, draft });
        setEditor(null);
    };

    const protocolLabel = (protocol: string | undefined) => (protocol === "anthropic" ? t("config.preferences.protocolAnthropic") : t("config.preferences.protocolOpenAI"));

    return (
        <div className="mb-4 border-t border-stone-200 pt-4 dark:border-stone-800">
            <div className="mb-1 flex items-center justify-between gap-3">
                <div className="text-sm font-semibold">{t("config.preferences.agentModels")}</div>
                <Button size="small" disabled={!session.connected} icon={<Plus className="size-3.5" />} onClick={() => setEditor({ draft: emptyModelDraft })}>
                    {t("config.preferences.addModel")}
                </Button>
            </div>
            <div className="mb-2 text-xs text-stone-500">{t("config.preferences.agentModelsNote")}</div>

            {session.models.length === 0 ? (
                <div className="mb-2 text-xs text-stone-500">{session.connected ? t("config.preferences.noAgentModels") : t("config.preferences.agentModelsConnecting")}</div>
            ) : (
                <div className="mb-2 divide-y divide-stone-200 rounded-md border border-stone-200 dark:divide-stone-800 dark:border-stone-800">
                    {session.models.map((model) => (
                        <div key={model.id} className="flex items-center gap-3 px-3 py-2">
                            <div className="min-w-0 flex-1">
                                <div className="truncate text-sm">{model.name || model.modelName}</div>
                                <div className="truncate text-xs text-stone-500">
                                    {protocolLabel(model.protocolType)} · {model.baseUrl}
                                    {model.modelName ? ` · ${model.modelName}` : ""}
                                </div>
                            </div>
                            {/* A key is shown as one: six dots, whether it is six characters or sixty. */}
                            <Tooltip title={model.hasKey ? t("config.preferences.apiKeyStored") : t("config.preferences.apiKeyMissing")}>
                                <span className="shrink-0 font-mono text-xs text-stone-400 select-none">{model.hasKey ? "••••••" : "—"}</span>
                            </Tooltip>
                            <Tooltip title={t("config.preferences.editModel")}>
                                <Button size="small" type="text" disabled={!session.connected} aria-label={t("config.preferences.editModel")} onClick={() => setEditor({ draft: modelDraftOf(model), id: model.id })} icon={<Pencil className="size-3.5" />} />
                            </Tooltip>
                            <Tooltip title={t("config.preferences.deleteModel")}>
                                <Button size="small" type="text" danger disabled={!session.connected} aria-label={t("config.preferences.deleteModel")} onClick={() => sync({ kind: "delete", id: model.id })} icon={<Trash2 className="size-3.5" />} />
                            </Tooltip>
                        </div>
                    ))}
                </div>
            )}

            {error ? <div className="mb-2 text-xs leading-5 text-red-500 dark:text-red-400">{error}</div> : null}

            {editor ? <AgentModelDialog draft={editor.draft} editing={editor.id !== undefined} onCancel={() => setEditor(null)} onSave={save} /> : null}
        </div>
    );
}
