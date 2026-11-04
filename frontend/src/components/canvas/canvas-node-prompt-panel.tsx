import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowUp, LoaderCircle, Maximize2, ScanText, X } from "lucide-react";

import { useTranslation } from "react-i18next";

import { Button } from "@/components/kit/button";
import { Dialog } from "@/components/kit/dialog";
import { toast } from "@/components/kit/toast";
import { Tooltip } from "@/components/kit/tooltip";
import { BaseModelPicker, ModelPicker, WorkflowModelPicker } from "@/components/model-picker";
import { channelModelOf, defaultConfig, modelOptionName, resolveModelForCapability, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";

import { nodePromptOf, promptPatch } from "@/lib/canvas/node-prompt-field";
import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import { isPlainEnterKey } from "@/lib/keyboard-event";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasAudioSettingsPopover, type CanvasAudioSettingKey } from "./canvas-audio-settings-popover";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";
import { AgentSettingsControls } from "./agent-settings-controls";
import { SentPromptDisclosure } from "./sent-prompt-disclosure";
import { CanvasNodeType, type CanvasGenerationMode, type CanvasNodeData } from "@/types/canvas";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { resolveCanvasReferenceImages } from "@/lib/canvas/canvas-resource-references";
import { requestPromptChat } from "@/services/api/prompts";
import { agentSession, endAgentSession, nodeAgent, openAgentSession, subscribeAgentSessions } from "@/services/api/agent";
import { videoModelForWorkflow, videoModelModePatch } from "@/lib/canvas/video-model-mode";
import { CanvasNodeReferenceBar } from "./canvas-node-reference-bar";
import { abortCaptionJob, hasCaptionJob, registerCaptionJob, releaseCaptionJob } from "@/lib/canvas/caption-jobs";

export type CanvasNodeGenerationMode = CanvasGenerationMode;

type CanvasNodePromptPanelProps = {
    node: CanvasNodeData;
    /** The canvas this node lives in: the name its agent is filed under. */
    isRunning: boolean;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => void;
    onGenerate: (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => void;
    onStop: (nodeId: string) => void;
    mentionReferences?: CanvasResourceReference[];
    nodes: CanvasNodeData[];
    connectedNodes?: CanvasNodeData[];
    onDisconnectReference?: (fromNodeId: string, toNodeId: string) => void;
    onStartReferenceSelection?: (nodeId: string) => void;
    onImageSettingsOpenChange?: (open: boolean) => void;
    onOpenMaskEditor?: (nodeId: string) => void;
    onOpenOutpaintEditor?: (nodeId: string) => void;
    onOpenMossLayoutEditor?: (nodeId: string) => void;
};

export function CanvasNodePromptPanel({
    node,
    nodes,
    isRunning,
    onConfigChange,
    onGenerate,
    onStop,
    mentionReferences = [],
    connectedNodes = [],
    onDisconnectReference,
    onStartReferenceSelection,
    onImageSettingsOpenChange,
    onOpenMaskEditor,
    onOpenOutpaintEditor,
    onOpenMossLayoutEditor,
}: CanvasNodePromptPanelProps) {
    const { t } = useTranslation();
    const globalConfig = useEffectiveConfig();
    const openPreferences = useConfigStore((state) => state.openPreferences);
    const theme = useCanvasTheme();
    const mode = defaultMode(node.type);
    const config = buildNodeConfig(globalConfig, node, mode);
    const hasTextContent = node.type === CanvasNodeType.Text && Boolean(node.metadata?.content?.trim());
    const hasImageContent = node.type === CanvasNodeType.Image && Boolean(node.metadata?.content);
    // The words this box holds — the question, never the answer: a text node's card is its content, and
    // `nodePromptOf` is the field the panel and the agent's `set_prompt` both write (#229).
    const [prompt, setPrompt] = useState(nodePromptOf(node));
    const [draft, setDraft] = useState(prompt);
    const draftRef = useRef(draft);
    const promptRef = useRef(prompt);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    draftRef.current = draft;
    promptRef.current = prompt;
    const [expanded, setExpanded] = useState(false);
    const imageReferences = mentionReferences.filter((reference) => reference.kind === "image");
    // What a connected text node will add to the request. The box does not hold it — nothing copies it
    // there — so it is the request, not the panel, that carries these words (docs/decisions.md #185).
    const connectedText = mentionReferences.some((reference) => reference.kind === "text" && reference.text?.trim());
    const workflowId = channelModelOf(config, config.model)?.model.workflowId || modelOptionName(config.model);
    const isH3T2V = mode === "video" && workflowId === "video-h3-t2v";
    const isCharacterSwap = workflowId === "video-h3-character-swap";
    const sourceVideoReference = mentionReferences.find((reference) => reference.kind === "video");
    const sourceVideoNode = sourceVideoReference ? nodes.find((item) => item.id === sourceVideoReference.nodeId) : undefined;
    const sourceVideoDurationSeconds = sourceVideoNode?.metadata?.durationMs && sourceVideoNode.metadata.durationMs > 0 ? sourceVideoNode.metadata.durationMs / 1000 : undefined;
    // This panel's own agent. Connecting starts it; the panel going away releases it, so a node that is
    // not being worked on holds no process at all.
    const agentName = nodeAgent(node.id);
    // The button reflects the session, not a flag beside it: this panel is connected exactly while its
    // agent is alive, and the agent is released when the answer ends.
    const agentConnected = useSyncExternalStore(subscribeAgentSessions, () => agentSession(agentName).connected);
    const [connecting, setConnecting] = useState(false);
    const captionStatus = mode === "text" ? node.metadata?.captionStatus : undefined;
    const captionRunning = mode === "text" && captionStatus === "running";
    const captionResult = mode === "text" ? node.metadata?.captionPrompt || "" : "";
    const captionError = mode === "text" ? node.metadata?.captionError || "" : "";
    // Captioning has exactly one path now: the connected agent reads the image and answers. There is no
    // separate vision endpoint to configure.
    const canCaption = mode === "text" && imageReferences.length > 0 && !isRunning && !captionRunning;
    const hasMediaReferences = mentionReferences.some((reference) => reference.kind !== "text");
    const textVideoHasReferences = isH3T2V && hasMediaReferences;
    const frameMode: "first" | "last" | "both" = node.metadata?.frameMode === "last" || node.metadata?.frameMode === "both" || node.metadata?.frameMode === "first" ? node.metadata.frameMode : imageReferences.length >= 2 ? "both" : "first";
    const changeVideoMode = (value: "text" | "frames" | "reference") => {
        if (workflowId === "video-h3-fast") {
            onConfigChange(node.id, { videoMode: value, ...(value === "frames" ? { frameMode } : {}) });
            return;
        }
        const baseId = value === "reference" ? "video-h3-ref2va" : value === "frames" ? "video-h3-frames" : "video-h3-t2v";
        const nextModel = videoModelForWorkflow(config, baseId);
        onConfigChange(node.id, { ...(nextModel ? { model: nextModel } : {}), videoMode: value, ...(value === "frames" ? { frameMode } : {}) });
    };

    // The words this panel shows are the node's — the field `nodePromptOf` names — which is the one the
    // agent's `set_prompt` writes too.
    const storedPrompt = nodePromptOf(node);

    // Follow the store, and only the store. A generation leaves the words alone, so nothing here is clobbered
    // by pressing generate; an agent's `set_prompt` is a different writer, and before this the textarea kept
    // showing what it had when the node was opened until the panel was collapsed and opened again. What the
    // user is typing wins: a box with the caret in it is not the store's to rewrite, and their next keystroke
    // reaches the store anyway.
    useEffect(() => {
        if (storedPrompt === promptRef.current) return;
        if (document.activeElement === textareaRef.current) return;
        setPrompt(storedPrompt);
        setDraft(storedPrompt);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [node.id, storedPrompt]);

    const commitPrompt = (value = textareaRef.current?.value ?? draft) => {
        if (value === promptRef.current) return;
        setPrompt(value);
        onConfigChange(node.id, promptPatch(node, value));
    };

    const commitPromptRef = useRef(commitPrompt);
    commitPromptRef.current = commitPrompt;

    useEffect(() => {
        const commitOnOutsidePointer = (event: PointerEvent) => {
            if (panelRef.current?.contains(event.target as Node)) return;
            commitPromptRef.current();
        };
        document.addEventListener("pointerdown", commitOnOutsidePointer, true);
        return () => document.removeEventListener("pointerdown", commitOnOutsidePointer, true);
    }, []);

    // Applying an answer — a caption, a rewrite the agent suggested — writes the prompt, and nothing else.
    //
    // For a text node this used to write the words into `content`, `prompt` and `composerContent` at once:
    // the last place the old "one sentence, three fields" model survived (#229), and a way for the panel
    // to overwrite a card nobody asked it to touch. The card is not the prompt's to rewrite (#230).
    const applyPromptResult = (value: string) => {
        setDraft(value);
        setPrompt(value);
        onConfigChange(node.id, promptPatch(node, value));
    };

    const submit = () => {
        const text = draft.trim();
        if (isRunning) return;
        // Nothing typed and nothing holding words on the other end. An empty node is not an input — a wire
        // carries content (#230) — so this is the state a half-wired canvas reaches, and a button that does
        // nothing is the one answer nobody can act on.
        if (!text && !connectedText) {
            toast.warning(t("canvas.runtime.nothingToSend"));
            return;
        }
        if (textVideoHasReferences) {
            toast.warning(t("canvas.promptPanel.videoTextRefsWarning"));
            return;
        }
        commitPrompt(draft);
        if (mode === "image" && workflowId === "image-qwen21") {
            // A mask is a node: whichever connected node carries one supplies it, so a run wired by
            // hand works the same as one the editor made. Without a mask there is nothing to inpaint.
            const hasMask = imageReferences.some((reference) => Boolean(nodes.find((item) => item.id === reference.nodeId)?.metadata?.mask?.storageKey));
            if (config.imageMode === "inpaint" && !hasMask) {
                // The editor draws on the node's own picture, so it cannot open on a node that has none:
                // without this the button would just do nothing.
                if (!node.metadata?.content) {
                    toast.warning(t("canvas.runtime.maskNodeNeeded"));
                    return;
                }
                onOpenMaskEditor?.(node.id);
                return;
            }
            if (config.imageMode === "outpaint") {
                onOpenOutpaintEditor?.(node.id);
                return;
            }
        }
        onGenerate(node.id, mode, text);
    };

    // The panel going away ends that node's agent: it was started for this panel, and nothing else is
    // reading it. (The canvas's own agent is the opposite case and lives until it is closed by hand.)
    useEffect(() => () => endAgentSession(agentName), [agentName]);

    // The first click starts an agent so its model list can be shown; the next asks the question.
    const connectAgent = async () => {
        setConnecting(true);
        try {
            await openAgentSession(config, agentName);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t("canvas.agent.connectFailed"));
        } finally {
            setConnecting(false);
        }
    };

    const clearCaptionPreview = () => {
        onConfigChange(node.id, { captionStatus: undefined, captionPrompt: undefined, captionError: undefined });
    };

    const captionPrompt = async () => {
        if (!canCaption) return;
        const controller = new AbortController();
        registerCaptionJob(node.id, controller);
        onConfigChange(node.id, { captionStatus: "running", captionPrompt: undefined, captionError: undefined });
        try {
            const images = await resolveCanvasReferenceImages(imageReferences.slice(0, 1), nodes);
            if (!images.length) throw new Error(t("canvas.promptPanel.captionNoImage"));
            // `requestPromptChat` opens the session first, which is what makes this work on a panel whose
            // agent has not been connected yet: the button is the only way in, so it cannot assume someone
            // pressed 连接 before it (#257).
            const result = await requestPromptChat(
                agentName,
                config,
                { prompt: "用一段话描述这张图片，输出可以直接当作生图提示词的描述，只输出描述本身。", images },
                {
                    signal: controller.signal,
                    onDelta: (text) => onConfigChange(node.id, { captionPrompt: text }),
                },
            );
            onConfigChange(node.id, { captionStatus: "done", captionPrompt: result });
        } catch (error) {
            if (controller.signal.aborted) clearCaptionPreview();
            else onConfigChange(node.id, { captionStatus: "error", captionError: error instanceof Error ? error.message : t("canvas.promptPanel.captionFailed") });
        } finally {
            releaseCaptionJob(node.id, controller);
        }
    };

    const stopCaption = () => {
        abortCaptionJob(node.id);
        clearCaptionPreview();
    };

    useEffect(() => {
        if (mode !== "text" || node.metadata?.captionStatus !== "running" || hasCaptionJob(node.id)) return;
        // A page reload loses the in-memory controller; do not leave a stale running state.
        clearCaptionPreview();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode, node.id, node.metadata?.captionStatus]);

    const openExpandedEditor = () => {
        setExpanded(true);
    };

    return (
        <div
            ref={panelRef}
            data-canvas-no-zoom
            className="rounded-2xl border p-3 shadow-2xl backdrop-blur"
            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            <CanvasNodeReferenceBar
                nodeId={node.id}
                nodes={nodes}
                connectedNodes={connectedNodes}
                onDisconnect={onDisconnectReference}
                onStartSelection={onStartReferenceSelection}
                addDisabled={isH3T2V}
                addDisabledHint={t("canvas.promptPanel.videoTextAddDisabled")}
            />
            {textVideoHasReferences ? <div className="mb-2 text-xs leading-4 text-[#ef4444]">{t("canvas.promptPanel.videoTextRefsWarning")}</div> : null}
            <textarea
                ref={textareaRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={() => commitPrompt()}
                onKeyDown={(event) => {
                    event.stopPropagation();
                    if (isPlainEnterKey(event)) {
                        event.preventDefault();
                        submit();
                    }
                }}
                className="thin-scrollbar h-40 w-full cursor-text resize-none rounded-xl px-3 py-2 text-sm leading-5 outline-none"
                style={{ background: "transparent", color: theme.node.text }}
                placeholder={t(`canvas.promptPanel.${mode === "image" && hasImageContent ? "editImage" : mode === "text" && hasTextContent ? "editText" : mode}`)}
            />

            <div className="mt-2 flex min-w-0 items-center justify-between gap-2">
                <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                    <Tooltip title={t("canvas.promptPanel.expandEditor")}>
                        <Button
                            type="text"
                            className="!h-8 !w-8 !min-w-8 shrink-0 !rounded-full !bg-transparent !p-0"
                            style={{ color: theme.node.text }}
                            icon={<Maximize2 className="size-3.5" />}
                            onClick={openExpandedEditor}
                            aria-label={t("canvas.promptPanel.expandEditor")}
                        />
                    </Tooltip>
                    {mode === "image" ? (
                        <>
                            <WorkflowModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="image" onMissingConfig={() => openPreferences()} className="max-w-[190px]" />
                            <BaseModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} className="max-w-[140px]" />
                            <CanvasImageSettingsPopover
                                config={config}
                                placement="topLeft"
                                buttonClassName="!h-10 !max-w-[170px] !justify-start !rounded-full !px-3"
                                onConfigChange={(key, value) => onConfigChange(node.id, { [key]: value })}
                                onParamsChange={(params) => onConfigChange(node.id, { params: { ...node.metadata?.params, ...params } })}
                                onMissingConfig={() => openPreferences()}
                                onOpenChange={onImageSettingsOpenChange}
                                onOpenMaskEditor={() => onOpenMaskEditor?.(node.id)}
                                onOpenOutpaintEditor={() => onOpenOutpaintEditor?.(node.id)}
                                onOpenMossLayoutEditor={() => onOpenMossLayoutEditor?.(node.id)}
                            />
                        </>
                    ) : mode === "video" ? (
                        <>
                            <WorkflowModelPicker
                                config={config}
                                value={config.model}
                                onChange={(model) => onConfigChange(node.id, videoModelModePatch(config, model))}
                                capability="video"
                                onMissingConfig={() => openPreferences()}
                                className="max-w-[190px]"
                            />
                            <BaseModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} className="max-w-[140px]" />
                            <CanvasVideoSettingsPopover
                                config={config}
                                buttonClassName="!h-10 !min-w-0 !max-w-[200px] !justify-start !rounded-full !px-2"
                                onConfigChange={(key, value) => onConfigChange(node.id, videoConfigPatch(key, value))}
                                frameMode={frameMode}
                                onFrameModeChange={(value) => onConfigChange(node.id, { frameMode: value })}
                                onModeChange={changeVideoMode}
                                durationLocked={isCharacterSwap}
                                sourceDurationSeconds={sourceVideoDurationSeconds}
                            />
                        </>
                    ) : mode === "audio" ? (
                        <>
                            <ModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="audio" onMissingConfig={() => openPreferences()} className="max-w-[190px]" />
                            <CanvasAudioSettingsPopover config={config} buttonClassName="!h-10 !max-w-[170px] !justify-start !rounded-full !px-3" onConfigChange={(key, value) => onConfigChange(node.id, audioConfigPatch(key, value))} />
                        </>
                    ) : (
                        <>
                            <AgentSettingsControls session={agentName} className="flex min-w-0 items-center gap-2" />
                        </>
                    )}
                </div>
                {mode === "text" ? (
                    <Tooltip title={canCaption ? t("canvas.promptPanel.captionHint") : t("canvas.promptPanel.captionNeedsImage")}>
                        <Button
                            type="text"
                            className="!h-10 ml-auto shrink-0 !rounded-full !px-2 text-xs"
                            style={{ color: theme.node.text }}
                            icon={captionRunning ? <LoaderCircle className="size-4 animate-spin" /> : <ScanText className="size-4" />}
                            disabled={!canCaption && !captionRunning}
                            onClick={() => (captionRunning ? stopCaption() : void captionPrompt())}
                            aria-label={captionRunning ? t("canvas.promptPanel.captionStop") : t("canvas.promptPanel.caption")}
                        >
                            {captionRunning ? t("canvas.promptPanel.captionStop") : t("canvas.promptPanel.captionShort")}
                        </Button>
                    </Tooltip>
                ) : null}
                <Button
                    type="primary"
                    className={`${mode === "text" ? "" : "ml-auto"} !h-10 shrink-0 !rounded-full ${isRunning || connecting ? "!min-w-10 !px-2" : "!min-w-16 !px-3"}`}
                    danger={isRunning}
                    disabled={!isRunning && !connecting && (mode === "text" && !agentConnected ? false : !draft.trim() && !connectedText)}
                    title={isRunning ? t("canvas.promptPanel.stop") : undefined}
                    onClick={() => {
                        if (isRunning) return onStop(node.id);
                        // Text: the first click starts an agent (so the model list appears), the next asks.
                        if (mode === "text" && !agentConnected) return void connectAgent();
                        submit();
                    }}
                    aria-label={t(isRunning ? "canvas.promptPanel.stop" : mode === "text" && !agentConnected ? "canvas.agent.connect" : "canvas.promptPanel.generate")}
                >
                    <span className="flex items-center gap-1.5">
                        {isRunning || connecting ? <LoaderCircle className="size-4 animate-spin" /> : mode === "text" && !agentConnected ? <span className="text-xs">{t("canvas.agent.connect")}</span> : <ArrowUp className="size-4" />}
                    </span>
                </Button>
            </div>
            <SentPromptDisclosure sent={node.metadata?.sentPrompt} current={draft} />
            {captionRunning || captionResult || captionError ? (
                <div className="mt-2 rounded-xl border p-2" style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel }}>
                    <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="text-xs font-medium">{t("canvas.promptPanel.captionTitle")}</span>
                        <Button
                            type="text"
                            size="small"
                            className="!h-6 !w-6 !min-w-6 !rounded-full !p-0"
                            icon={<X className="size-3.5" />}
                            onClick={() => (captionRunning ? stopCaption() : clearCaptionPreview())}
                            aria-label={t(captionRunning ? "canvas.promptPanel.captionStop" : "canvas.promptPanel.previewClose")}
                        />
                    </div>
                    {captionRunning ? (
                        <div className="flex items-center gap-2 text-xs opacity-70">
                            <LoaderCircle className="size-3.5 animate-spin" />
                            <span>{t("canvas.promptPanel.captioning")}</span>
                        </div>
                    ) : null}
                    {captionError ? <div className="text-xs text-[#ef4444]">{captionError}</div> : null}
                    {captionResult ? (
                        <>
                            <textarea
                                readOnly
                                value={captionResult}
                                className="thin-scrollbar mt-2 h-40 w-full resize-none rounded-lg border p-2 text-xs leading-5 outline-none"
                                style={{ borderColor: theme.toolbar.border, background: "transparent", color: theme.node.text }}
                                onWheel={(event) => event.stopPropagation()}
                            />
                            <div className="mt-2 flex justify-end gap-2">
                                <Button size="small" onClick={() => clearCaptionPreview()}>
                                    {t("canvas.promptPanel.previewClose")}
                                </Button>
                                <Button
                                    size="small"
                                    onClick={() => {
                                        applyPromptResult(draft.trim() ? `${draft.trim()}\n\n${captionResult}` : captionResult);
                                        clearCaptionPreview();
                                    }}
                                >
                                    {t("canvas.promptPanel.appendPrompt")}
                                </Button>
                                <Button
                                    size="small"
                                    type="primary"
                                    onClick={() => {
                                        applyPromptResult(captionResult);
                                        clearCaptionPreview();
                                    }}
                                >
                                    {t("canvas.promptPanel.replacePrompt")}
                                </Button>
                            </div>
                        </>
                    ) : null}
                </div>
            ) : null}
            <Dialog
                title={t("canvas.promptPanel.editorTitle")}
                open={expanded}
                size="panel"
                onClose={() => {
                    commitPrompt();
                    setExpanded(false);
                }}
            >
                <div data-canvas-no-zoom className="pt-2" onWheelCapture={(event) => event.stopPropagation()}>
                    <CanvasNodeReferenceBar
                        nodeId={node.id}
                        nodes={nodes}
                        connectedNodes={connectedNodes}
                        onDisconnect={onDisconnectReference}
                        onStartSelection={(nodeId) => {
                            setExpanded(false);
                            onStartReferenceSelection?.(nodeId);
                        }}
                        addDisabled={isH3T2V}
                        addDisabledHint={t("canvas.promptPanel.videoTextAddDisabled")}
                    />
                    {textVideoHasReferences ? <div className="mb-2 text-xs leading-4 text-[#ef4444]">{t("canvas.promptPanel.videoTextRefsWarning")}</div> : null}
                    <textarea
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        onBlur={() => commitPrompt()}
                        onKeyDown={(event) => {
                            event.stopPropagation();
                            if (isPlainEnterKey(event)) {
                                event.preventDefault();
                                submit();
                            }
                        }}
                        className="thin-scrollbar h-[52dvh] min-h-80 w-full resize-none rounded-xl border p-4 text-[15px] leading-6 outline-none"
                        style={{ background: "transparent", borderColor: theme.toolbar.border, color: theme.node.text }}
                        placeholder={t(`canvas.promptPanel.${mode === "image" && hasImageContent ? "editImage" : mode === "text" && hasTextContent ? "editText" : mode}`)}
                    />
                </div>
            </Dialog>
        </div>
    );
}

function defaultMode(type: CanvasNodeData["type"]): CanvasNodeGenerationMode {
    return type === CanvasNodeType.Text ? "text" : type === CanvasNodeType.Video ? "video" : type === CanvasNodeType.Audio ? "audio" : "image";
}

function buildNodeConfig(globalConfig: AiConfig, node: CanvasNodeData, mode: CanvasNodeGenerationMode): AiConfig {
    return {
        ...globalConfig,
        model: resolveModelForCapability(globalConfig, node.metadata?.model, mode),
        quality: node.metadata?.quality || globalConfig.quality || defaultConfig.quality,
        size: node.metadata?.size || globalConfig.size || defaultConfig.size,
        background: node.metadata?.background ?? "",
        videoSeconds: node.metadata?.seconds || globalConfig.videoSeconds || defaultConfig.videoSeconds,
        vquality: node.metadata?.vquality || globalConfig.vquality || defaultConfig.vquality,
        videoGenerateAudio: node.metadata?.generateAudio || globalConfig.videoGenerateAudio || defaultConfig.videoGenerateAudio,
        videoWatermark: node.metadata?.watermark || globalConfig.videoWatermark || defaultConfig.videoWatermark,
        videoMode: node.metadata?.videoMode || globalConfig.videoMode || defaultConfig.videoMode,
        videoSelfLiftMode: node.metadata?.videoSelfLiftMode || globalConfig.videoSelfLiftMode || "fast",
        frameMode: node.metadata?.frameMode,
        imageMode: node.metadata?.imageMode || globalConfig.imageMode || "",
        outpaint: node.metadata?.outpaint || globalConfig.outpaint,
        layout: node.metadata?.layout || globalConfig.layout,
        audioFormat: node.metadata?.audioFormat || globalConfig.audioFormat || defaultConfig.audioFormat,
        audioSeconds: node.metadata?.seconds || globalConfig.audioSeconds || defaultConfig.audioSeconds,
        audioInstructions: node.metadata?.audioInstructions || globalConfig.audioInstructions || defaultConfig.audioInstructions,
        seed: node.metadata?.seed || globalConfig.seed || "",
        seedFixed: node.metadata?.seedFixed ?? globalConfig.seedFixed ?? "false",
        params: node.metadata?.params || globalConfig.params,
    };
}

function videoConfigPatch(key: keyof AiConfig, value: string) {
    if (key === "videoSeconds") return { seconds: value };
    if (key === "videoGenerateAudio") return { generateAudio: value };
    if (key === "videoWatermark") return { watermark: value };
    if (key === "videoMode") return { videoMode: value };
    if (key === "videoSelfLiftMode") return { videoSelfLiftMode: value };
    return { [key]: value };
}

function audioConfigPatch(key: CanvasAudioSettingKey, value: string) {
    if (key === "audioFormat") return { audioFormat: value };
    if (key === "audioSeconds") return { seconds: value };
    return { audioInstructions: value };
}
