import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/kit/button";
import { Checkbox } from "@/components/kit/choice";
import { Dialog } from "@/components/kit/dialog";
import { Field } from "@/components/kit/field";
import { Input } from "@/components/kit/input";
import { DEFAULT_SPEECH_MODEL, speechDraftComplete, type SpeechDraft } from "@/lib/speech-profiles";

/**
 * One speech server, as a form: a name, the address it listens on, the model it calls its own, and its key.
 *
 * It is a dialog rather than a row of inputs under the list, for the reason the agent's model dialog is one: a
 * server is a small document, and four fields on one line is a form nobody can read (#249, #252).
 *
 * Add and edit are the same form. What differs is the key: a profile that exists has one this page has never
 * been shown, so empty means "the one that is stored" and the note says so; removing it is a checkbox, because
 * a blank field cannot mean both "keep" and "delete". A new profile with an empty key gets no key, which a
 * local endpoint is happy with.
 */
export function SpeechProfileDialog({ draft: initial, editing, hasKey, onCancel, onSave }: { draft: SpeechDraft; editing: boolean; hasKey: boolean; onCancel: () => void; onSave: (draft: SpeechDraft) => void }): ReactNode {
    const { t } = useTranslation();
    const [draft, setDraft] = useState<SpeechDraft>(initial);
    const change = (patch: Partial<SpeechDraft>) => setDraft((current) => ({ ...current, ...patch }));
    const ready = speechDraftComplete(draft);
    const save = () => ready && onSave(draft);

    return (
        <Dialog
            open
            onClose={onCancel}
            size="form"
            title={editing ? t("config.preferences.speechEditTitle") : t("config.preferences.speechAddTitle")}
            footer={
                <>
                    <Button onClick={onCancel}>{t("common.cancel")}</Button>
                    <Button type="primary" disabled={!ready} onClick={save}>
                        {t("common.save")}
                    </Button>
                </>
            }
        >
            <Field label={t("config.preferences.speechName")} className="mb-3">
                <Input value={draft.name} onChange={(event) => change({ name: event.target.value })} onPressEnter={save} />
            </Field>
            {/* The address is the one field a request cannot do without, so it is the first one that has to be
                right: an OpenAI-compatible `/v1/audio/transcriptions`, reachable from the machine the *server*
                runs on, because the server is the process that posts the audio. */}
            <Field label={t("config.preferences.speechAddress")} className="mb-3">
                <Input value={draft.url} placeholder="https://…" onChange={(event) => change({ url: event.target.value })} onPressEnter={save} />
            </Field>
            <Field label={t("config.preferences.speechModel")} className="mb-3">
                <Input value={draft.model} placeholder={DEFAULT_SPEECH_MODEL} onChange={(event) => change({ model: event.target.value })} onPressEnter={save} />
            </Field>
            <Field label={t("config.preferences.speechKey")} className={hasKey ? "mb-2" : "mb-0"}>
                <Input
                    type="password"
                    autoComplete="off"
                    value={draft.key}
                    disabled={draft.removeKey}
                    // A password field's placeholder is not masked, which is what makes it usable for the one
                    // thing it has to say on an existing profile: the stored key is kept unless it is replaced.
                    placeholder={editing && hasKey ? t("config.preferences.apiKeyKeepHint") : t("config.preferences.speechKeyPlaceholder")}
                    onChange={(event) => change({ key: event.target.value, removeKey: false })}
                    onPressEnter={save}
                />
            </Field>
            {hasKey ? (
                <Checkbox checked={draft.removeKey} onChange={(event) => change({ removeKey: event.target.checked, key: "" })}>
                    {t("config.preferences.speechKeyClear")}
                </Checkbox>
            ) : null}
        </Dialog>
    );
}
