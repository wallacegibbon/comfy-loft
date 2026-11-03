import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/kit/button";
import { Switch } from "@/components/kit/choice";
import { Dialog } from "@/components/kit/dialog";
import { Field } from "@/components/kit/field";
import { Input } from "@/components/kit/input";
import { Select } from "@/components/kit/select";
import { WorkflowModelPicker } from "@/components/model-picker";
import { imageAspectOptions } from "@/components/image-settings-panel";
import { videoResolutionOptions } from "@/components/video-settings-panel";
import { AgentModelsSection } from "@/components/settings/agent-models-section";
import { computeMediaSize, inferMediaRatio, inferMediaScale, mediaScaleOptions, parseVideoResolution } from "@/lib/media-size";
import { loadSpeechKey, saveSpeechKey } from "@/services/api/speech";
import { useConfigStore, DEFAULT_SPEECH_ADDRESS, DEFAULT_SPEECH_MODEL, type ModelCapability } from "@/stores/use-config-store";

/**
 * The media kinds with a default model to pick.
 *
 * Only these two: text runs on the agent and has no model of its own (`hydrateConfig` clears `textModel`),
 * and the audio model is chosen per node in the prompt panel, so a default here would be a setting nothing
 * reads.
 */
const modelGroups: Array<{ capability: ModelCapability; modelKey: "imageModel" | "videoModel"; labelKey: string }> = [
    { capability: "image", modelKey: "imageModel", labelKey: "config.preferences.defaultImageModel" },
    { capability: "video", modelKey: "videoModel", labelKey: "config.preferences.defaultVideoModel" },
];

/**
 * The preferences window: the default models and the generation defaults.
 *
 * There is nothing to apply. Every control writes into `use-config-store`, which mirrors the document to
 * the server as it changes (#155, #166), so closing the window loses nothing and a "Done" button would
 * only be claiming to do what already happened.
 *
 * The server itself is not here. The channel is the server that served the page — its address comes from
 * the page and its models from `GET /api/workflows` (#71) — so the "Server" tab that let you rename it and
 * re-tag a model's media kind was a form over values nothing else could change.
 */
export function PreferencesDialog() {
    const { t } = useTranslation();
    const open = useConfigStore((state) => state.preferencesOpen);
    const setOpen = useConfigStore((state) => state.setPreferencesOpen);
    const config = useConfigStore((state) => state.config);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const imageResolutionOptions = mediaScaleOptions.map((value) => ({ value, label: value === "auto" ? t("settingsPanels.common.auto") : value.toUpperCase() }));

    return (
        <Dialog
            open={open}
            onClose={() => setOpen(false)}
            size="panel"
            title={
                <div>
                    <div className="text-lg font-semibold">{t("config.preferences.title")}</div>
                    <div className="mt-1 text-xs font-normal text-stone-500">{t("config.preferences.description")}</div>
                </div>
            }
            bodyStyle={{ maxHeight: "72vh" }}
            bodyClassName="pr-3"
        >
            <div className="border-b border-stone-200 pb-3 text-xs text-stone-500 dark:border-stone-800">{t("config.settingsNote")}</div>
            <div className="mb-2 mt-4 text-sm font-semibold">{t("config.preferences.defaultModels")}</div>
            <div className="mb-4 grid gap-4 md:grid-cols-2">
                {modelGroups.map((group) => (
                    <Field key={group.modelKey} label={t(group.labelKey)} className="mb-0">
                        <WorkflowModelPicker config={config} value={config[group.modelKey]} onChange={(model) => updateConfig(group.modelKey, model)} capability={group.capability} fullWidth />
                    </Field>
                ))}
            </div>
            <div className="mb-2 text-sm font-semibold">{t("config.preferences.generation")}</div>
            <div className="grid gap-4 md:grid-cols-4">
                <Field label={t("config.preferences.imageResolution")} className="mb-4">
                    <Select value={inferMediaScale(config.size)} options={imageResolutionOptions} onChange={(scale) => updateConfig("size", computeMediaSize(scale, inferMediaRatio(config.size)))} />
                </Field>
                <Field label={t("config.preferences.imageAspectRatio")} className="mb-4">
                    <Select value={inferMediaRatio(config.size)} options={imageAspectOptions} onChange={(ratio) => updateConfig("size", computeMediaSize(inferMediaScale(config.size), ratio))} />
                </Field>
                <Field label={t("config.preferences.videoResolution")} className="mb-4">
                    <Select value={parseVideoResolution(config.vquality)} options={videoResolutionOptions} onChange={(value) => updateConfig("vquality", value)} />
                </Field>
            </div>
            <Field className="mb-4">
                <div className="flex items-center justify-between gap-3">
                    <span className="text-sm">{t("config.preferences.autoFocusOnSelect")}</span>
                    <Switch checked={config.autoFocusOnSelect} onChange={(checked) => updateConfig("autoFocusOnSelect", checked)} />
                </div>
            </Field>
            <AgentModelsSection />
            {/* Speech is the other way words get into the agent's prompt. Three fields, because three of
                the things a speech server says about itself are not in the protocol: where it listens, what
                it calls its model, and whether it wants a credential. The server makes the request, so the
                address only has to be true of the machine the server runs on. */}
            <div className="mb-4 border-t border-stone-200 pt-4 dark:border-stone-800">
                <div className="mb-1 text-sm font-semibold">{t("config.preferences.speech")}</div>
                <div className="mb-2 text-xs text-stone-500">{t("config.preferences.speechNote")}</div>
                <Field label={t("config.preferences.speechAddress")} className="mb-4">
                    <Input value={config.asrUrl} placeholder={DEFAULT_SPEECH_ADDRESS} onChange={(event) => updateConfig("asrUrl", event.target.value)} />
                </Field>
                <Field label={t("config.preferences.speechModel")} className="mb-4">
                    <Input value={config.asrModel} placeholder={DEFAULT_SPEECH_MODEL} onChange={(event) => updateConfig("asrModel", event.target.value)} />
                </Field>
                <Field label={t("config.preferences.speechKey")} className="mb-0">
                    <SpeechKeyField baseUrl={config.baseUrl} />
                </Field>
            </div>
            <Field label={t("config.preferences.systemPrompt")} className="mb-0">
                <Input.TextArea rows={4} value={config.systemPrompt} placeholder={t("config.preferences.systemPromptPlaceholder")} onChange={(event) => updateConfig("systemPrompt", event.target.value)} />
            </Field>
        </Dialog>
    );
}

/**
 * The speech server's credential: a field that can replace it, and a line that says whether one is stored.
 *
 * The key is **never sent to this page** — `data/settings.json` is served to every browser that loads the
 * canvas, so a credential in it would be a credential for anyone who can reach the server (#246). What the
 * form can do is store a new key or clear the stored one, which is why it is the one control here that does
 * not autosave: a half-typed key must not be written on every keystroke, and a blank field means "keep what
 * is stored", not "erase it" — the same rule the agent's model keys already follow
 * (`config.preferences.apiKeyKeepHint`).
 */
function SpeechKeyField({ baseUrl }: { baseUrl: string }) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState("");
    const [stored, setStored] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        let live = true;
        void loadSpeechKey({ baseUrl })
            .then((answer) => {
                if (live) setStored(answer);
            })
            .catch((failure: unknown) => {
                if (live) setError(failure instanceof Error ? failure.message : String(failure));
            });
        return () => {
            live = false;
        };
    }, [baseUrl]);

    const save = async (key: string) => {
        setBusy(true);
        setError("");
        try {
            setStored(await saveSpeechKey({ baseUrl }, key));
            setDraft("");
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div>
            <div className="flex items-start gap-2">
                <Input type="password" autoComplete="off" value={draft} placeholder={stored ? t("config.preferences.apiKeyKeepHint") : t("config.preferences.speechKeyPlaceholder")} onChange={(event) => setDraft(event.target.value)} />
                <Button size="middle" loading={busy} disabled={!draft.trim()} onClick={() => void save(draft)}>
                    {t("config.preferences.speechKeySave")}
                </Button>
                {stored ? (
                    <Button size="middle" danger disabled={busy} onClick={() => void save("")}>
                        {t("config.preferences.speechKeyClear")}
                    </Button>
                ) : null}
            </div>
            <div className="mt-1 text-xs text-stone-500">{error || (stored ? t("config.preferences.apiKeyStored") : t("config.preferences.apiKeyMissing"))}</div>
        </div>
    );
}
