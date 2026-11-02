import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/kit/button";
import { Dialog } from "@/components/kit/dialog";
import { Field } from "@/components/kit/field";
import { Input } from "@/components/kit/input";
import { Select } from "@/components/kit/select";
import { modelDraftComplete, type ModelDraft, type ModelProtocol } from "@/lib/agent-models";

/**
 * One model, as a form: the five things `model.conf` needs and nothing else.
 *
 * It is a dialog rather than a row of inputs under the list, because a model *is* a small document —
 * AlayaCore's entry has a name, an id, an address, a protocol and a key, and no two of them belong on one
 * line. The list behind it stays a list.
 *
 * Add and edit are the same form. What differs is the key: a model that exists has one the page has never
 * been shown, so empty means "the one that is stored" and the note says so. A new model with an empty key
 * gets no key, which a local endpoint is happy with.
 */
export function AgentModelDialog({ draft: initial, editing, onCancel, onSave }: { draft: ModelDraft; editing: boolean; onCancel: () => void; onSave: (draft: ModelDraft) => void }): ReactNode {
    const { t } = useTranslation();
    const [draft, setDraft] = useState<ModelDraft>(initial);
    const change = (patch: Partial<ModelDraft>) => setDraft((current) => ({ ...current, ...patch }));
    const ready = modelDraftComplete(draft);

    return (
        <Dialog
            open
            onClose={onCancel}
            size="form"
            title={editing ? t("config.preferences.modelEditTitle") : t("config.preferences.modelAddTitle")}
            footer={
                <>
                    <Button onClick={onCancel}>{t("common.cancel")}</Button>
                    <Button type="primary" disabled={!ready} onClick={() => onSave(draft)}>
                        {t("common.save")}
                    </Button>
                </>
            }
        >
            <Field label={t("config.preferences.modelName")} className="mb-3">
                <Input value={draft.name} onChange={(event) => change({ name: event.target.value })} onPressEnter={() => ready && onSave(draft)} />
            </Field>
            <Field label={t("config.preferences.modelId")} className="mb-3">
                <Input value={draft.modelId} onChange={(event) => change({ modelId: event.target.value })} onPressEnter={() => ready && onSave(draft)} />
            </Field>
            <Field label={t("config.preferences.modelUrl")} className="mb-3">
                <Input value={draft.baseUrl} placeholder="https://…" onChange={(event) => change({ baseUrl: event.target.value })} onPressEnter={() => ready && onSave(draft)} />
            </Field>
            <Field label={t("config.preferences.modelProtocol")} className="mb-3">
                <Select<ModelProtocol>
                    value={draft.protocol}
                    onChange={(protocol) => change({ protocol })}
                    options={[
                        { value: "openai", label: t("config.preferences.protocolOpenAI") },
                        { value: "anthropic", label: t("config.preferences.protocolAnthropic") },
                    ]}
                />
            </Field>
            <Field label={t("config.preferences.modelApiKey")} className="mb-0">
                <Input
                    type="password"
                    autoComplete="off"
                    value={draft.apiKey}
                    // A password field's placeholder is not masked, which is what makes it usable for the one
                    // thing this field has to say on an existing model: the stored key is kept unless it is
                    // replaced.
                    placeholder={editing ? t("config.preferences.apiKeyKeepHint") : undefined}
                    onChange={(event) => change({ apiKey: event.target.value })}
                    onPressEnter={() => ready && onSave(draft)}
                />
            </Field>
        </Dialog>
    );
}
