import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/kit/button";
import { Checkbox, Switch } from "@/components/kit/choice";
import { Dialog } from "@/components/kit/dialog";
import { Field } from "@/components/kit/field";
import { Input, InputNumber } from "@/components/kit/input";
import { Select } from "@/components/kit/select";
import { INPUT_MEDIA, modelDraftComplete, reasoningError, withModality, type ModelDraft, type ModelProtocol } from "@/lib/agent-models";

/**
 * One model, as a form: every field of the `model.conf` entry a page can see.
 *
 * It is a dialog rather than a row of inputs under the list, because a model *is* a small document —
 * AlayaCore's entry has a name, an id, an address, a protocol, a key, two token caps, three reasoning blocks,
 * two switches and the input types it declares, and no two of them belong on one line (#249, #256). The list
 * behind it stays a list.
 *
 * Add and edit are the same form. What differs is the key: a model that exists has one the page has never
 * been shown, so empty means "the one that is stored" and the note says so. A new model with an empty key
 * gets no key, which a local endpoint is happy with.
 *
 * The reasoning blocks are JSON text, because they are JSON: each is merged into the request body as-is at
 * one reasoning level, and no form of named fields could say what a provider accepts. A blank box is a
 * decision — it removes the block — and text that is not a JSON object keeps the Save button off.
 *
 * The input types are the one field with three states — not declared, declared empty, declared as a list —
 * which is why they are a switch and four boxes rather than four boxes (#256).
 */
export function AgentModelDialog({ draft: initial, editing, onCancel, onSave }: { draft: ModelDraft; editing: boolean; onCancel: () => void; onSave: (draft: ModelDraft) => void }): ReactNode {
    const { t } = useTranslation();
    const [draft, setDraft] = useState<ModelDraft>(initial);
    const change = (patch: Partial<ModelDraft>) => setDraft((current) => ({ ...current, ...patch }));
    const ready = modelDraftComplete(draft);
    // `null` is "not declared", which is a state of its own — a switch, not an empty checkbox row.
    const declared = draft.inputModalities;
    const reasoning = [
        { key: "reasoning0" as const, label: t("config.preferences.modelReasoning0") },
        { key: "reasoning1" as const, label: t("config.preferences.modelReasoning1") },
        { key: "reasoning2" as const, label: t("config.preferences.modelReasoning2") },
    ];

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
            {/* Three states in one control, because the file has three: no line at all (the switch, off), an
                empty declaration (on, nothing ticked) and a list. A row of checkboxes alone could not say the
                first one, and a model whose `[]` is read as "not declared" comes back unlimited. */}
            <Field className="mb-3">
                <div className="flex items-center justify-between gap-3">
                    <span className="text-sm">{t("config.preferences.modelInputModalities")}</span>
                    <Switch checked={declared !== null} onChange={(on) => change({ inputModalities: on ? (declared ?? []) : null })} />
                </div>
                {declared === null ? (
                    <div className="mt-1 text-xs text-stone-500">{t("config.preferences.modelInputModalitiesUnrestricted")}</div>
                ) : (
                    <>
                        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
                            {INPUT_MEDIA.map((modality) => (
                                <Checkbox key={modality} checked={declared.includes(modality)} onChange={(event) => change({ inputModalities: withModality(declared, modality, event.target.checked) })}>
                                    {t(`config.preferences.modality.${modality}`)}
                                </Checkbox>
                            ))}
                        </div>
                        {/* Denied by default: a medium the endpoint turns out to accept costs a note saying it was
                            not delivered, while one it does not accept makes the request fail — every time, since
                            the part is in the conversation the agent keeps replaying. */}
                        <div className="mt-1 text-xs text-stone-500">{declared.length ? t("config.preferences.modelInputModalitiesNote") : t("config.preferences.modelInputModalitiesNone")}</div>
                    </>
                )}
            </Field>
            <Field label={t("config.preferences.modelApiKey")} className="mb-3">
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
            <div className="mb-3 grid grid-cols-2 gap-3">
                <Field label={t("config.preferences.modelContextLimit")} className="mb-0">
                    <InputNumber min={0} step={1024} value={draft.contextLimit ? Number(draft.contextLimit) : null} onChange={(value) => change({ contextLimit: value === null ? "" : String(value) })} />
                </Field>
                <Field label={t("config.preferences.modelMaxTokens")} className="mb-0">
                    <InputNumber min={0} step={1024} value={draft.maxTokens ? Number(draft.maxTokens) : null} onChange={(value) => change({ maxTokens: value === null ? "" : String(value) })} />
                </Field>
            </div>
            <Field label={t("config.preferences.modelReasoningField")} className="mb-3">
                <Input value={draft.reasoningField} placeholder="reasoning_content" onChange={(event) => change({ reasoningField: event.target.value })} />
            </Field>
            <Field className="mb-3">
                <div className="flex items-center justify-between gap-3">
                    <span className="text-sm">{t("config.preferences.modelSerialToolCalls")}</span>
                    <Switch checked={draft.serialToolCalls} onChange={(serialToolCalls) => change({ serialToolCalls })} />
                </div>
            </Field>
            <div className="mb-1 text-xs text-stone-500">{t("config.preferences.modelReasoningNote")}</div>
            {reasoning.map(({ key, label }) => {
                const error = reasoningError(draft[key]);
                return (
                    <Field key={key} label={label} className="mb-2">
                        <Input.TextArea rows={2} spellCheck={false} status={error ? "error" : "normal"} className="font-mono text-xs" value={draft[key]} onChange={(event) => change({ [key]: event.target.value } as Partial<ModelDraft>)} />
                        {error ? <div className="mt-1 text-xs text-red-500">{t(error)}</div> : null}
                    </Field>
                );
            })}
        </Dialog>
    );
}
