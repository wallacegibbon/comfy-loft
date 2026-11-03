import { create } from "zustand";
import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { gatewayModelLabel } from "@/lib/gateway-labels";
import { gatewayRoot, LOCAL_GATEWAY_BASE_URL, LOCAL_GATEWAY_CHANNEL_ID } from "@/constant/app-mode";
import { mirrorToSettings, readSetting } from "@/stores/use-settings-store";

export type ModelCapability = "image" | "video" | "text" | "audio";

export type ChannelModel = {
    name: string;
    capability: ModelCapability;
    label?: string;
    workflowId?: string;
    baseModel?: string;
    baseModelLabel?: string;
    variantModes?: string[];
    /** Modes the gateway reports as blocked: they would fail inside ComfyUI, so they are not offered. */
    blockedModes?: string[];
    variantLabels?: Record<string, string>;
    imageInputs?: number;
};

type ModelChannel = {
    id: string;
    /** The stored name: a user-typed one, or a snapshot of the translated default. */
    name: string;
    /**
     * The translation key a generated name came from. Present only until the user renames the channel;
     * while it is, the name is rendered in the reader's language (docs/decisions.md #70).
     */
    nameKey?: string;
    baseUrl: string;
    models: ChannelModel[];
};

export type AiConfig = {
    baseUrl: string;
    channels: ModelChannel[];
    model: string;
    imageModel: string;
    videoModel: string;
    textModel: string;
    audioModel: string;
    audioVoice: string;
    audioFormat: string;
    audioSpeed: string;
    audioInstructions: string;
    /**
     * Where the speech server listens, for the words dictated into the agent's prompt.
     *
     * An OpenAI-compatible `POST /v1/audio/transcriptions` that takes a WAV file and answers `{"text": …}`.
     * The page posts the recording to the gateway and the gateway posts it here, because that server answers
     * no CORS headers and is usually only reachable from this machine (`services/api/speech.ts`, #239).
     */
    asrUrl: string;
    videoSeconds: string;
    vquality: string;
    videoGenerateAudio: string;
    videoWatermark: string;
    videoMode: string;
    videoSelfLiftMode?: string;
    promptOptimizeLanguage?: "zh" | "en";
    frameMode?: "first" | "last" | "both";
    imageMode?: string;
    outpaint?: { left: number; top: number; right: number; bottom: number; width: number; height: number };
    layout?: { summary: string; regions: Array<{ id: string; label: "object" | "character" | "text"; caption: string; text?: string; x: number; y: number; width: number; height: number }>; width?: number; height?: number };
    systemPrompt: string;
    models: string[];
    quality: string;
    size: string;
    background: string;
    autoFocusOnSelect: boolean;
    seed?: string;
    seedFixed?: string;
    params?: Record<string, unknown>;
};

/**
 * The speech server this build was measured against: a local audio.cpp server.
 *
 * It is filled in rather than left blank because the field is the only setting the feature has, and a blank
 * one would make a working setup look like a missing one. Any OpenAI-compatible `/v1/audio/transcriptions`
 * that takes WAV works — that is the whole of the protocol this build knows (#239).
 */
export const DEFAULT_SPEECH_ADDRESS = "http://127.0.0.1:18080/v1/audio/transcriptions";

const CHANNEL_MODEL_SEPARATOR = "::";
const localDefaultChannel: ModelChannel = {
    id: LOCAL_GATEWAY_CHANNEL_ID,
    name: i18n.t("config.channels.localName"),
    nameKey: "config.channels.localName",
    baseUrl: LOCAL_GATEWAY_BASE_URL,
    models: [],
};

// One literal, no shared base to override: this build only ever talks to the
// local gateway, so a second default config would be dead weight that has to be kept
// in sync field by field.
export const defaultConfig: AiConfig = {
    baseUrl: LOCAL_GATEWAY_BASE_URL,
    channels: [localDefaultChannel],
    // No workflow id is baked in as the default: the first image/video workflow the gateway reports
    // becomes the selection (see `pickModel` below), so adding or renaming a workflow in the registry
    // never leaves the canvas pointing at a model that is gone.
    model: "",
    imageModel: "",
    videoModel: "",
    textModel: "",
    audioModel: "",
    audioVoice: "alloy",
    audioFormat: "mp3",
    audioSpeed: "1",
    audioInstructions: "",
    // The local audio.cpp speech server: the address the panel's dictation was built and measured against
    // (rtf ≈ 0.12, WAV in, `{"text": …}` out). It is a default and not a constant because a speech server
    // is somewhere else on somebody else's machine, so the field is the setting.
    asrUrl: DEFAULT_SPEECH_ADDRESS,
    videoSeconds: "6",
    vquality: "720",
    videoGenerateAudio: "true",
    videoWatermark: "false",
    // Local workflows are driven by a start frame, not by free text.
    videoMode: "text",
    videoSelfLiftMode: "fast",
    promptOptimizeLanguage: "zh",
    systemPrompt: "",
    models: [],
    quality: "auto",
    size: "1:1",
    background: "",
    autoFocusOnSelect: false,
};

type ConfigStore = {
    config: AiConfig;
    /**
     * The two floating windows over the canvas that read this config each keep their own flag: they are
     * separate windows (`preferences-dialog.tsx`, `workflows-dialog.tsx`), opened from separate buttons.
     */
    preferencesOpen: boolean;
    workflowsOpen: boolean;
    updateConfig: <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;
    isAiConfigReady: (config: AiConfig, model: string) => boolean;
    openPreferences: () => void;
    openWorkflows: () => void;
    setPreferencesOpen: (open: boolean) => void;
    setWorkflowsOpen: (open: boolean) => void;
};

const VIDEO_KEYWORDS = ["video", "sora", "veo", "kling", "wan", "hailuo"];

const AUDIO_KEYWORDS = ["audio", "tts", "speech", "voice", "music", "sound"];
const IMAGE_KEYWORDS = ["seedream", "gpt-image", "image", "dall-e", "dalle", "imagen", "flux", "sdxl", "stable-diffusion", "midjourney"];

/**
 * Best-effort capability for a bare model name.
 *
 * Only a stored config that predates `ChannelModel` can contain one: everything the canvas writes
 * today is an object with a capability, and the gateway reports the kind itself (`type`). It stays as
 * the fallback for that legacy shape rather than dropping the model.
 */
function guessCapability(name: string): ModelCapability {
    const value = name.toLowerCase();
    if (VIDEO_KEYWORDS.some((keyword) => value.includes(keyword))) return "video";
    if (AUDIO_KEYWORDS.some((keyword) => value.includes(keyword))) return "audio";
    if (IMAGE_KEYWORDS.some((keyword) => value.includes(keyword))) return "image";
    return "text";
}

function findChannelModel(config: AiConfig, value: string): { channel: ModelChannel; model: ChannelModel } | null {
    const decoded = decodeChannelModel(value);
    const name = decoded?.model || value;
    const channel = decoded ? config.channels.find((item) => item.id === decoded.channelId) : config.channels.find((item) => item.models.some((model) => model.name === name));
    const model = channel?.models.find((item) => item.name === name);
    return channel && model ? { channel, model } : null;
}

function modelCapabilityOf(config: AiConfig, value: string): ModelCapability | undefined {
    return findChannelModel(config, value)?.model.capability;
}

export function resolveModelForCapability(config: AiConfig, currentModel: string | undefined, capability: ModelCapability) {
    const defaultModel = capability === "image" ? config.imageModel : capability === "video" ? config.videoModel : capability === "audio" ? config.audioModel : config.textModel;
    const fallbackModel = capability === "image" ? defaultConfig.imageModel : capability === "video" ? defaultConfig.videoModel : capability === "audio" ? defaultConfig.audioModel : defaultConfig.textModel;
    for (const model of [currentModel, defaultModel]) {
        if (!model) continue;
        const configuredCapability = modelCapabilityOf(config, model);
        // In local mode a model that has disappeared from the registry falls back to the default for its capability.
        if (!configuredCapability) continue;
        // Keep unavailable selections visible so the readiness check blocks the
        // request. Only a known capability switch may choose another model.
        if (!configuredCapability || configuredCapability === capability) return model;
    }
    return fallbackModel;
}

export function selectableModelsByCapability(config: AiConfig, capability?: ModelCapability) {
    if (!capability) return config.models;
    return config.channels.flatMap((channel) => channel.models.filter((model) => model.capability === capability).map((model) => encodeChannelModel(channel.id, model.name)));
}

function channelModelEntries(config: AiConfig) {
    return config.channels.flatMap((channel) => channel.models.map((model) => ({ channel, model, value: encodeChannelModel(channel.id, model.name) })));
}

export function channelModelOf(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    const name = decoded?.model || value;
    for (const channel of config.channels) {
        if (decoded && channel.id !== decoded.channelId) continue;
        const model = channel.models.find((item) => item.name === name);
        if (model) return { channel, model };
    }
    return null;
}

/** Top-level dropdown: grouped by workflow, base-model entries only; falls back to a flat list without grouping metadata. */
export function workflowModelOptions(config: AiConfig, capability?: ModelCapability) {
    const entries = channelModelEntries(config);
    if (!entries.some((entry) => entry.model.workflowId)) return selectableModelsByCapability(config, capability);
    return entries.filter((entry) => entry.model.workflowId && !entry.model.baseModel && (!capability || entry.model.capability === capability)).map((entry) => entry.value);
}

/** The base-model entry of the workflow the current model belongs to, used to echo the top-level dropdown. */
export function workflowModelValue(config: AiConfig, value: string) {
    const found = channelModelOf(config, value);
    if (!found?.model.workflowId) return value;
    const base = found.channel.models.find((model) => model.workflowId === found.model.workflowId && !model.baseModel);
    return base ? encodeChannelModel(found.channel.id, base.name) : value;
}

/** Second-level dropdown: the workflow's default base model plus every variant. */
export function baseModelOptions(config: AiConfig, value: string) {
    const found = channelModelOf(config, value);
    const workflowId = found?.model.workflowId;
    if (!found || !workflowId) return [];
    return found.channel.models
        .filter((model) => model.workflowId === workflowId)
        .map((model) => ({
            value: encodeChannelModel(found.channel.id, model.name),
            label: gatewayModelLabel(model.name, model.baseModelLabel || model.label || model.name),
            isDefault: !model.baseModel,
            name: model.name,
        }));
}

export function modelImageInputs(config: AiConfig, value: string) {
    const found = channelModelOf(config, value);
    return typeof found?.model.imageInputs === "number" ? found.model.imageInputs : undefined;
}

function isAiConfigReady(config: AiConfig, model: string) {
    const match = findChannelModel(config, model);
    return Boolean(match && match.channel.baseUrl.trim());
}

/**
 * Bring a stored config up to the shape this build expects.
 *
 * The stored document is whatever the last build wrote, so every field is re-derived rather than
 * trusted: channels are rebuilt from their ids and models, the model selections are re-picked from
 * what those channels actually offer, and the enums fall back to their defaults. The alternative is a
 * canvas pointing at a model that the gateway stopped reporting, which looks like a broken button.
 */
function hydrateConfig(stored: Partial<AiConfig>): AiConfig {
    const config = { ...defaultConfig, ...stored };
    if (!Array.isArray(stored.channels)) config.channels = [];
    const channels = normalizeChannels(config);
    const models = modelOptionsFromChannels(channels);
    const imageOptions = channels.flatMap((channel) => channel.models.filter((model) => model.capability === "image").map((model) => encodeChannelModel(channel.id, model.name)));
    const videoOptions = channels.flatMap((channel) => channel.models.filter((model) => model.capability === "video").map((model) => encodeChannelModel(channel.id, model.name)));
    const audioOptions = channels.flatMap((channel) => channel.models.filter((model) => model.capability === "audio").map((model) => encodeChannelModel(channel.id, model.name)));
    const pickModel = (current: string, options: string[]) => (options.includes(current) ? current : options[0] || "");
    return {
        ...config,
        model: pickModel(config.model || config.imageModel, imageOptions),
        channels,
        models,
        imageModel: pickModel(config.imageModel || config.model, imageOptions),
        videoModel: pickModel(config.videoModel, videoOptions),
        textModel: "",
        audioModel: pickModel(config.audioModel, audioOptions),
        audioVoice: config.audioVoice || defaultConfig.audioVoice,
        audioFormat: config.audioFormat || defaultConfig.audioFormat,
        audioSpeed: config.audioSpeed || defaultConfig.audioSpeed,
        audioInstructions: config.audioInstructions || "",
        videoSeconds: config.videoSeconds || "6",
        vquality: config.vquality || "720",
        videoGenerateAudio: config.videoGenerateAudio || "true",
        videoWatermark: config.videoWatermark || "false",
        videoMode: config.videoMode === "reference" || config.videoMode === "text" ? config.videoMode : "frames",
        videoSelfLiftMode: config.videoSelfLiftMode === "quality" ? "quality" : "fast",
        autoFocusOnSelect: Boolean(config.autoFocusOnSelect),
    };
}

export const useConfigStore = create<ConfigStore>()((set) => ({
    config: hydrateConfig(readSetting<Partial<AiConfig>>("config", {})),
    preferencesOpen: false,
    workflowsOpen: false,
    updateConfig: (key, value) =>
        set((state) => ({
            config: {
                ...state.config,
                [key]: value,
            },
        })),
    isAiConfigReady: (config, model) => isAiConfigReady(config, model),
    openPreferences: () => set({ preferencesOpen: true }),
    openWorkflows: () => set({ workflowsOpen: true }),
    setPreferencesOpen: (preferencesOpen) => set({ preferencesOpen }),
    setWorkflowsOpen: (workflowsOpen) => set({ workflowsOpen }),
}));

// The channel name and the model selections are a preference: they are the same on the phone in the next
// room, and they survive a cleared browser.
mirrorToSettings(useConfigStore, "config", (state) => state.config);

/**
 * The config every caller should read.
 *
 * It used to be a copy with `channelMode` forced to "local", because a cloud mode
 * still existed and could have set it. With cloud mode deleted the field was always
 * "local", so there is nothing left to force and this is the stored config itself.
 */
export function useEffectiveConfig() {
    return useConfigStore((state) => state.config);
}

/** Normalize a mixed list of raw model names or model objects into deduped ChannelModel entries. */
export function normalizeChannelModels(models: Array<string | ChannelModel> | undefined): ChannelModel[] {
    const seen = new Set<string>();
    const result: ChannelModel[] = [];
    for (const item of models || []) {
        const name = (typeof item === "string" ? item : item?.name || "").trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const capability = typeof item === "string" ? guessCapability(name) : item.capability || guessCapability(name);
        const label = typeof item === "string" ? undefined : item.label?.trim() || undefined;
        const workflowId = typeof item === "string" ? undefined : item.workflowId?.trim() || undefined;
        const baseModel = typeof item === "string" ? undefined : item.baseModel?.trim() || undefined;
        const baseModelLabel = typeof item === "string" ? undefined : item.baseModelLabel?.trim() || undefined;
        const variantModes = typeof item === "string" ? undefined : Array.isArray(item.variantModes) ? item.variantModes.map((mode) => String(mode).trim()).filter(Boolean) : undefined;
        const blockedModes = typeof item === "string" ? undefined : Array.isArray(item.blockedModes) ? item.blockedModes.map((mode) => String(mode).trim()).filter(Boolean) : undefined;
        const variantLabels = typeof item === "string" ? undefined : item.variantLabels && typeof item.variantLabels === "object" ? item.variantLabels : undefined;
        const imageInputs = typeof item === "string" ? undefined : typeof item.imageInputs === "number" ? item.imageInputs : undefined;
        result.push({ name, capability, label, workflowId, baseModel, baseModelLabel, variantModes, variantLabels, blockedModes, imageInputs });
    }
    return result;
}

/**
 * The channel name to render.
 *
 * Same rule as a node title: a key wins, so a channel created in the Chinese UI does not appear under its
 * Chinese name in the English one. A name the user typed has no key and is shown as typed.
 */
export function channelName(channel: Pick<ModelChannel, "name" | "nameKey">) {
    return channel.nameKey ? i18n.t(channel.nameKey) : channel.name;
}

/**
 * The key a stored channel name was rendered from, when it was one of the app's own defaults.
 *
 * Read from both dictionaries: the stored snapshot came from whichever language was active when the
 * channel was created.
 */
function defaultChannelNameKey(name: string): string | undefined {
    const value = name.trim();
    if (!value) return undefined;
    for (const language of ["zh-CN", "en-US"] as const) {
        // The language is named on every call rather than taken from the active one: the stored snapshot could
        // have been written in either language, and this has to recognise both.
        if (i18n.t("config.channels.localName", { lng: language }) === value) return "config.channels.localName";
    }
    return undefined;
}

function createModelChannel(channel?: Partial<ModelChannel>): ModelChannel {
    const name = channel?.name?.trim() || "";
    return {
        id: channel?.id?.trim() || nanoid(),
        name: name || i18n.t("config.channels.newName"),
        // The stored address is the gateway root; an older config may still end in /v1.
        baseUrl: gatewayRoot(channel?.baseUrl || defaultBaseUrl()),
        // An older config stored the translated default; adopt the key so the name follows the language.
        nameKey: channel?.nameKey || defaultChannelNameKey(name) || undefined,
        models: normalizeChannelModels(channel?.models),
    };
}

export function encodeChannelModel(channelId: string, model: string) {
    return `${channelId}${CHANNEL_MODEL_SEPARATOR}${model.trim()}`;
}

function decodeChannelModel(value: string) {
    const index = value.indexOf(CHANNEL_MODEL_SEPARATOR);
    if (index < 0) return null;
    return { channelId: value.slice(0, index), model: value.slice(index + CHANNEL_MODEL_SEPARATOR.length) };
}

export function modelOptionName(value: string) {
    return decodeChannelModel(value)?.model || value;
}

export function modelOptionLabel(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    if (!decoded) return value;
    const channel = config.channels.find((item) => item.id === decoded.channelId);
    const model = channel?.models.find((item) => item.name === decoded.model);
    // The label arrives in English from the gateway registry; the dictionary supplies the
    // Chinese one, keyed by the model id, and the gateway text is the fallback.
    const label = gatewayModelLabel(decoded.model, model?.label);
    if (label !== decoded.model) return label;
    return channel ? i18n.t("settingsPanels.model.withChannel", { model: decoded.model, channel: channelName(channel) }) : decoded.model;
}

export function modelOptionsFromChannels(channels: ModelChannel[]) {
    return uniqueModelOptions(channels.flatMap((channel) => channel.models.map((model) => encodeChannelModel(channel.id, model.name))));
}

function resolveModelChannel(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    const model = decoded?.model || value;
    const matched = decoded ? config.channels.find((channel) => channel.id === decoded.channelId) : config.channels.find((channel) => channel.models.some((item) => item.name === model));
    return (
        matched ||
        config.channels[0] ||
        createModelChannel({
            id: "default",
            name: i18n.t("config.channels.defaultName"),
            baseUrl: config.baseUrl,
            models: config.models.map(modelOptionName).map((name) => ({ name, capability: guessCapability(name) })),
        })
    );
}

export function resolveModelRequestConfig(config: AiConfig, value: string) {
    const channel = resolveModelChannel(config, value);
    return {
        ...config,
        model: modelOptionName(value || config.model),
        baseUrl: channel.baseUrl,
    };
}

function normalizeChannels(config: AiConfig) {
    const persistedChannels = Array.isArray(config.channels) ? config.channels : [];
    const channels = persistedChannels.map((channel, index) =>
        createModelChannel({
            ...channel,
            id: channel.id || (index === 0 ? "default" : `channel-${index + 1}`),
            name: channel.name || (index === 0 ? i18n.t("config.channels.defaultName") : i18n.t("config.channels.indexedName", { index: index + 1 })),
            models: normalizeChannelModels(channel.models),
        }),
    );
    if (!channels.length) {
        channels.push(
            createModelChannel({
                id: "default",
                name: i18n.t("config.channels.defaultName"),
                baseUrl: config.baseUrl || defaultConfig.baseUrl,
                models: normalizeChannelModels([config.model, config.imageModel, config.videoModel, config.textModel, config.audioModel].map(modelOptionName)),
            }),
        );
    }
    return channels;
}

/** Every channel in this build points at the local gateway; there is no cloud default. */
function defaultBaseUrl() {
    return LOCAL_GATEWAY_BASE_URL;
}

function uniqueModelOptions(models: string[]) {
    return Array.from(new Set((models || []).map((model) => model.trim()).filter(Boolean)));
}
