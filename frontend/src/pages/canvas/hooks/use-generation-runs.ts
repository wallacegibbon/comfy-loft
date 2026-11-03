import { useCallback, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { nanoid } from "nanoid";

import { toast } from "@/components/kit/toast";
import { requestAudioGeneration } from "@/services/api/audio";
import { requestEdit, requestGeneration } from "@/services/api/image";
import { nodeAgent } from "@/services/api/agent";
import { requestPromptChat } from "@/services/api/prompts";
import { waitForRun, type Run, type RunProgress, type RunRequest } from "@/services/api/runs";
import type { GenerateStart } from "@/lib/canvas/agent-generate";
import { generatedAudio, generatedImage } from "@/lib/canvas/generated-media";
import { NO_MAKER } from "@/lib/canvas/node-generation-facts";
import { isVideoTaskFailed } from "@/services/api/video";
import { resolveModelRequestConfig, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { imageToDataUrl, type UploadedImage } from "@/services/image-storage";
import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { fitNodeSize, nodeSizeFromRatio } from "@/lib/canvas/canvas-node-size";
import { audioMetadata, buildAudioGenerationMetadata, buildImageGenerationMetadata, imageMetadata } from "@/lib/canvas/canvas-node-factory";
import { buildGenerationConfig, findRetrySourceNode, generationReferenceUrls, hasResumableVideoTask, isGenerationCanceled, resolveMetadataReferences, sourceNodeReferenceImages } from "@/lib/canvas/canvas-generation-helpers";
import { NODE_STATUS_ERROR, NODE_STATUS_IDLE, NODE_STATUS_LOADING, NODE_STATUS_SUCCESS } from "@/lib/canvas/canvas-node-status";
import { buildNodeGenerationContext, hydrateNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeText } from "@/types/canvas";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import type { ReferenceImage } from "@/types/image";

/**
 * One generation request, as every mode needs to see it.
 *
 * The four modes disagree about almost everything below this line, but they agree about this: which
 * node was asked, what the hydrated prompt turned out to be, which config was resolved, whether the
 * result overwrites the source, and the abort controller of the request that owns the whole run.
 */
export type GenerationRun = {
    nodeId: string;
    prompt: string;
    sourceNode: CanvasNodeData | undefined;
    effectivePrompt: string;
    generationConfig: ReturnType<typeof import("@/lib/canvas/canvas-generation-helpers").buildGenerationConfig>;
    generationContext: Awaited<ReturnType<typeof hydrateNodeGenerationContext>>;
    runController: AbortController;
    /**
     * Filled in by whichever mode ran, so the caller's `catch` can put the nodes it created into the
     * error state. It has to be mutable and it has to survive the mode returning early, which is why
     * it is a field on the run rather than a return value.
     */
    pendingChildIds: string[];
    /**
     * The agent that asked for this generation, if one did. It rides along to the run, which is where the
     * gateway keeps "who is waiting to be told" — the tool call that started this is answered long before
     * the run ends (docs/decisions.md #225).
     */
    askedBy?: RunRequest["askedBy"];
    /**
     * Says whether a run exists, the moment it does. The tool's answer waits on this — "a run went out"
     * is the one thing that tells the agent whether to expect a message later (#225).
     */
    start: (start: GenerateStart) => void;
};

export type GenerationRunDeps = {
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    setSelectedNodeIds: Dispatch<SetStateAction<Set<string>>>;
    setSelectedConnectionId: Dispatch<SetStateAction<string | null>>;
    setDialogNodeId: Dispatch<SetStateAction<string | null>>;
    nodesRef: MutableRefObject<CanvasNodeData[]>;
    connectionsRef: MutableRefObject<CanvasConnection[]>;
    setRunningNodeId: Dispatch<SetStateAction<string | null>>;
    pollVideoNodeTask: (node: CanvasNodeData, silent?: boolean) => Promise<void>;
    startGenerationRequest: (targetNodeId: string, originNodeId: string, runningId?: string, controller?: AbortController, expectedProgressCount?: number) => AbortController;
    finishGenerationRequest: (targetNodeId: string, controller: AbortController) => void;
    completeVideoNodeTask: (
        nodeId: string,
        config: GenerationRun["generationConfig"],
        prompt: string,
        images: Parameters<typeof import("@/services/api/video").createVideoGenerationTask>[2],
        signal: AbortSignal,
        options?: {
            askedBy?: RunRequest["askedBy"];
            /** Called with the run id the moment it exists, before the wait for its result. */
            started?: (runId: string) => void;
            extra?: CanvasNodeData["metadata"];
            videos?: ReferenceVideo[];
            audios?: ReferenceAudio[];
        },
    ) => Promise<void>;
};

/**
 * Inpaint takes its mask from the node that carries one, not from the picture that node draws.
 *
 * A mask node shows the mask painted over the source, because that is what a person needs to see; the
 * file the workflow consumes is bound to the same node (`metadata.mask`). So an inpaint run asks each
 * connected node what mask it stands for, and only falls back to the picture for nodes that carry none.
 */
async function withBoundMasks(references: ReferenceImage[], nodes: CanvasNodeData[]): Promise<ReferenceImage[]> {
    return Promise.all(
        references.map(async (reference) => {
            // The id is the node id — bare from the generation inputs, `canvas:<id>` from the resource
            // resolver — so the prefix is stripped rather than required.
            const nodeId = reference.id.replace(/^canvas:/, "");
            const mask = nodes.find((node) => node.id === nodeId)?.metadata?.mask;
            if (!mask?.storageKey) return reference;
            const dataUrl = await imageToDataUrl({ storageKey: mask.storageKey });
            return dataUrl ? { ...reference, dataUrl, storageKey: mask.storageKey } : reference;
        }),
    );
}

/**
 * The four things "generate" can mean.
 *
 * They were four branches of a single 440-line `handleGenerateNode`, sharing nothing but the setup
 * above and the `catch` in the caller. Each one spawns or repurposes nodes, drives its own request
 * shape — parallel images, a polled video task, a single audio clip, a streamed text answer — and
 * then stamps the outcome onto the graph.
 */
export function useGenerationRuns(deps: GenerationRunDeps) {
    const { setNodes, setConnections, setSelectedNodeIds, setSelectedConnectionId, setDialogNodeId, nodesRef, connectionsRef, setRunningNodeId, pollVideoNodeTask, startGenerationRequest, finishGenerationRequest, completeVideoNodeTask } = deps;
    const { t } = useTranslation();
    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openPreferences = useConfigStore((state) => state.openPreferences);

    /** Node ids whose run is currently being polled, so a resume and a live run cannot both poll. */
    const audioPollIdsRef = useRef(new Set<string>());
    /** The same guard for image batches, which resume from the same kind of run. */
    const imagePollIdsRef = useRef(new Set<string>());

    /**
     * Run progress is the only source of the step ring for audio: the node is not a video task, so
     * there is no preview stream to read steps from.
     */
    const setRunStepProgress = useCallback(
        (nodeId: string, progress?: RunProgress) => {
            const total = progress?.total && progress.total > 0 ? progress.total : 0;
            const step = Math.max(0, progress?.step || 0);
            setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, stepProgress: total > 0 ? { step: Math.min(total, step), total } : undefined } } : node)));
        },
        [setNodes],
    );

    /**
     * Turn a run's artifact into the node's own content.
     *
     * Called by the live run and by the resume path alike, which is what makes a reloaded run look like one
     * that never stopped. The picture is the file the run wrote into the canvas — nothing is copied (#173) —
     * and the node is resized around it, because a node holds one picture and its shape is that picture's (#180).
     */
    const fillImage = useCallback(
        async (rootId: string, uploaded: UploadedImage) => {
            const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
            const imageSize = fitNodeSize(uploaded.width, uploaded.height, imageConfig.width, imageConfig.height);
            setNodes((prev) =>
                prev.map((node) => {
                    if (node.id !== rootId) return node;
                    const center = { x: node.position.x + node.width / 2, y: node.position.y + node.height / 2 };
                    return {
                        ...node,
                        position: { x: center.x - imageSize.width / 2, y: center.y - imageSize.height / 2 },
                        ...imageSize,
                        metadata: { ...node.metadata, ...imageMetadata(uploaded) },
                    };
                }),
            );
        },
        [setNodes],
    );

    const failImage = useCallback(
        (rootId: string, errorDetails: string) => {
            setNodes((prev) => prev.map((node) => (node.id === rootId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails } } : node)));
        },
        [setNodes],
    );

    const runImageGeneration = useCallback(
        async (run: GenerationRun) => {
            const { nodeId, prompt, sourceNode, effectivePrompt, generationConfig, generationContext, runController } = run;
            const isConfigNode = sourceNode?.type === CanvasNodeType.Config;
            const isImageNode = sourceNode?.type === CanvasNodeType.Image;
            // An image node answers in place. A variant is a new node fed with this one through the
            // reference bar — whatever is connected here is what conditions the request, nothing else.
            let referenceImages = [...new Map(generationContext.referenceImages.map((image) => [image.id, image])).values()];
            if (generationConfig.imageMode === "inpaint") referenceImages = await withBoundMasks(referenceImages, nodesRef.current);
            const generationType = referenceImages.length ? ("edit" as const) : ("generation" as const);
            const generationMetadata = buildImageGenerationMetadata(generationType, generationConfig, referenceImages);
            const parentConfig = NODE_DEFAULT_SIZE[isConfigNode ? CanvasNodeType.Config : isImageNode ? CanvasNodeType.Image : CanvasNodeType.Text];
            const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
            const parentPosition = sourceNode?.position || { x: 0, y: 0 };
            const rootId = isImageNode ? nodeId : nanoid();
            run.pendingChildIds = [rootId];
            const rootNode: CanvasNodeData = {
                id: rootId,
                type: CanvasNodeType.Image,
                title: prompt.slice(0, 32) || "Generated Image",
                position: {
                    x: isImageNode ? parentPosition.x : parentPosition.x + parentConfig.width + 96,
                    y: parentPosition.y + parentConfig.height / 2 - imageConfig.height / 2,
                },
                width: isImageNode ? sourceNode?.width || imageConfig.width : imageConfig.width,
                height: isImageNode ? sourceNode?.height || imageConfig.height : imageConfig.height,
                metadata: {
                    prompt,
                    // What actually went out. The box holds what the user typed and the request is that
                    // plus whatever is connected to it, so the difference is the panel's to show
                    // (docs/decisions.md #185) — never the node's prompt, which stays the user's words.
                    sentPrompt: effectivePrompt,
                    status: NODE_STATUS_LOADING,
                    ...generationMetadata,
                },
            };

            setNodes((prev) => [
                ...prev.map((node) =>
                    node.id === nodeId
                        ? isConfigNode
                            ? {
                                  ...node,
                                  metadata: { ...node.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined },
                              }
                            : isImageNode
                              ? {
                                    ...node,
                                    position: rootNode.position,
                                    width: rootNode.width,
                                    height: rootNode.height,
                                    // A node regenerated in place keeps its name when the box has no words to
                                    // name it by: the request was the connected text, and "【Text 1】…" is
                                    // not a title.
                                    ...(prompt ? { title: rootNode.title } : {}),
                                    metadata: {
                                        ...node.metadata,
                                        ...rootNode.metadata,
                                        content: undefined,
                                        storageKey: undefined,
                                        naturalWidth: undefined,
                                        naturalHeight: undefined,
                                        bytes: undefined,
                                        mimeType: undefined,
                                        // The picture they described is gone: a run that fails leaves the node
                                        // with no content and must not leave it claiming to hold one (#227).
                                        ...NO_MAKER,
                                        errorDetails: undefined,
                                    },
                                }
                              : {
                                    ...node,
                                    type: CanvasNodeType.Text,
                                    title: prompt.slice(0, 32) || "Prompt",
                                    width: parentConfig.width,
                                    height: parentConfig.height,
                                    metadata: { ...node.metadata, content: prompt, prompt, status: NODE_STATUS_SUCCESS, fontSize: 14, errorDetails: undefined },
                                }
                        : node,
                ),
                ...(isImageNode ? [] : [rootNode]),
            ]);
            if (!isImageNode) setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: nodeId, toNodeId: rootId }]);
            setSelectedNodeIds(new Set([nodeId]));
            setSelectedConnectionId(null);
            setDialogNodeId(nodeId);

            const controller = startGenerationRequest(rootId, nodeId, nodeId, runController);
            let hasSuccess = false;
            let hasFailure = false;
            let firstError = "";
            const markConfigSuccess = () => {
                if (!isConfigNode) return;
                setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS, errorDetails: undefined } } : node)));
            };

            // One run, one picture: the gateway writes the artifact into the canvas and the node names it by
            // reference (#173, #180).
            try {
                const requestOptions = {
                    signal: controller.signal,
                    askedBy: run.askedBy,
                    onProgress: (state: Run) => setRunStepProgress(rootId, state.progress),
                    // The id arrives at submission, before a single artifact exists: it is what a
                    // reload reattaches to.
                    onRun: (runId: string) => {
                        setNodes((prev) => prev.map((node) => (node.id === rootId ? { ...node, metadata: { ...node.metadata, imageRunId: runId } } : node)));
                        run.start({ started: true, runId });
                    },
                };
                const result = referenceImages.length ? await requestEdit(generationConfig, effectivePrompt, referenceImages, requestOptions) : await requestGeneration(generationConfig, effectivePrompt, requestOptions);
                await fillImage(rootId, result);
                hasSuccess = true;
                markConfigSuccess();
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.runtime.generationFailed");
                if (!firstError) firstError = errorDetails;
                hasFailure = true;
                failImage(rootId, errorDetails);
            } finally {
                setRunStepProgress(rootId, undefined);
            }
            if (rootId !== nodeId) finishGenerationRequest(rootId, controller);
            if (controller.signal.aborted) {
                setNodes((prev) => prev.map((node) => (node.id === nodeId && isConfigNode && node.metadata?.status === NODE_STATUS_LOADING ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_IDLE, errorDetails: undefined } } : node)));
                return;
            }
            if (hasFailure) {
                toast.error(hasSuccess ? t("canvas.runtime.partialFailed") : firstError || t("canvas.runtime.generationFailed"));
            }
            setNodes((prev) =>
                prev.map((node) =>
                    node.id === nodeId && isConfigNode
                        ? { ...node, metadata: { ...node.metadata, status: hasSuccess ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR, errorDetails: hasSuccess ? undefined : t("canvas.runtime.generationFailed") } }
                        : node.id === rootId
                          ? {
                                ...node,
                                metadata: {
                                    ...node.metadata,
                                    status: hasSuccess ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR,
                                    errorDetails: hasSuccess ? undefined : t("canvas.runtime.allFailed"),
                                    imageRunId: undefined,
                                },
                            }
                          : node,
                ),
            );
        },
        [failImage, fillImage, finishGenerationRequest, startGenerationRequest, t],
    );

    const runVideoGeneration = useCallback(
        async (run: GenerationRun) => {
            const { nodeId, prompt, sourceNode, effectivePrompt, generationConfig, generationContext, runController } = run;
            const spec = nodeSizeFromRatio(generationConfig.size, NODE_DEFAULT_SIZE[CanvasNodeType.Video].width, NODE_DEFAULT_SIZE[CanvasNodeType.Video].height) || NODE_DEFAULT_SIZE[CanvasNodeType.Video];
            const reuseVideoNode = sourceNode?.type === CanvasNodeType.Video;
            const videoId = reuseVideoNode ? nodeId : nanoid();
            const parent = sourceNode?.position || { x: 0, y: 0 };
            const videoNode: CanvasNodeData = {
                id: videoId,
                type: CanvasNodeType.Video,
                title: prompt.slice(0, 32) || "Generated Video",
                position: reuseVideoNode ? sourceNode.position : { x: parent.x + (sourceNode?.width || spec.width) + 96, y: parent.y },
                width: reuseVideoNode ? sourceNode.width : spec.width,
                height: reuseVideoNode ? sourceNode.height : spec.height,
                metadata: {
                    prompt,
                    sentPrompt: effectivePrompt,
                    status: NODE_STATUS_LOADING,
                    model: generationConfig.model,
                    size: generationConfig.size,
                    seconds: generationConfig.videoSeconds,
                    vquality: generationConfig.vquality,
                    generateAudio: generationConfig.videoGenerateAudio,
                    watermark: generationConfig.videoWatermark,
                    videoMode: generationConfig.videoMode,
                    references: generationReferenceUrls(generationContext),
                },
            };
            run.pendingChildIds = [videoId];
            setNodes((prev) =>
                reuseVideoNode
                    ? prev.map((node) => (node.id === nodeId ? { ...node, ...videoNode, title: prompt ? videoNode.title : node.title } : node))
                    : [...prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS } } : node)), videoNode],
            );
            if (!reuseVideoNode) setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: nodeId, toNodeId: videoId }]);
            const controller = startGenerationRequest(videoId, nodeId, nodeId, runController);
            try {
                await completeVideoNodeTask(videoId, generationConfig, effectivePrompt, generationContext.referenceImages, controller.signal, {
                    askedBy: run.askedBy,
                    started: (runId) => run.start({ started: true, runId }),
                    extra: {
                        size: generationConfig.size,
                        seconds: generationConfig.videoSeconds,
                        vquality: generationConfig.vquality,
                        generateAudio: generationConfig.videoGenerateAudio,
                        watermark: generationConfig.videoWatermark,
                        videoMode: generationConfig.videoMode,
                        references: generationReferenceUrls(generationContext),
                    },
                    videos: generationContext.referenceVideos,
                    audios: generationContext.referenceAudios,
                });
            } finally {
                finishGenerationRequest(videoId, controller);
            }
            return;
        },
        [completeVideoNodeTask, finishGenerationRequest, startGenerationRequest, t],
    );

    const runAudioGeneration = useCallback(
        async (run: GenerationRun) => {
            const { nodeId, prompt, sourceNode, effectivePrompt, generationConfig, runController } = run;
            const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
            const reuseAudioNode = sourceNode?.type === CanvasNodeType.Audio;
            const audioId = reuseAudioNode ? nodeId : nanoid();
            const parent = sourceNode?.position || { x: 0, y: 0 };
            const audioNode: CanvasNodeData = {
                id: audioId,
                type: CanvasNodeType.Audio,
                title: prompt.slice(0, 32) || "Generated Audio",
                position: reuseAudioNode ? sourceNode.position : { x: parent.x + (sourceNode?.width || spec.width) + 96, y: parent.y + ((sourceNode?.height || spec.height) - spec.height) / 2 },
                width: reuseAudioNode ? sourceNode.width : spec.width,
                height: reuseAudioNode ? sourceNode.height : spec.height,
                metadata: { prompt, sentPrompt: effectivePrompt, status: NODE_STATUS_LOADING, ...buildAudioGenerationMetadata(generationConfig) },
            };
            run.pendingChildIds = [audioId];
            setNodes((prev) =>
                reuseAudioNode
                    ? prev.map((node) => (node.id === nodeId ? { ...node, ...audioNode, title: prompt ? audioNode.title : node.title } : node))
                    : [...prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS } } : node)), audioNode],
            );
            if (!reuseAudioNode) setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: nodeId, toNodeId: audioId }]);
            const controller = startGenerationRequest(audioId, nodeId, nodeId, runController);
            try {
                const audio = await requestAudioGeneration(generationConfig, effectivePrompt, {
                    signal: controller.signal,
                    askedBy: run.askedBy,
                    // The id lands on the node before the first poll, so a reload can resume it.
                    onRun: (runId) => {
                        setNodes((prev) => prev.map((node) => (node.id === audioId ? { ...node, metadata: { ...node.metadata, audioRunId: runId } } : node)));
                        run.start({ started: true, runId });
                    },
                    onProgress: (run) => setRunStepProgress(audioId, run.progress),
                });
                setNodes((prev) =>
                    prev.map((node) => (node.id === audioId ? { ...node, metadata: { ...node.metadata, ...audioMetadata(audio), prompt, ...buildAudioGenerationMetadata(generationConfig), audioRunId: undefined, stepProgress: undefined } } : node)),
                );
            } finally {
                finishGenerationRequest(audioId, controller);
            }
            return;
        },
        [finishGenerationRequest, setNodes, setRunStepProgress, startGenerationRequest],
    );

    const runTextGeneration = useCallback(
        async (run: GenerationRun) => {
            const { nodeId, prompt, sourceNode, effectivePrompt, generationConfig, generationContext, runController } = run;
            const isConfigNode = sourceNode?.type === CanvasNodeType.Config;
            // One prompt, one answer: a connected agent answers exactly one question, so a batch of texts
            // is no longer a thing (the count control went with the old text settings).
            const textCount = 1;
            const parentConfig = NODE_DEFAULT_SIZE[isConfigNode ? CanvasNodeType.Config : CanvasNodeType.Text];
            const textConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
            const parentPosition = sourceNode?.position || { x: 0, y: 0 };
            // Asked from a text node, the answer belongs to that node: generating again rewrites it
            // rather than dropping a second one beside it. A config node still produces a new text
            // node, because there the output is not the thing you pressed.
            const reuseTextNode = sourceNode?.type === CanvasNodeType.Text;
            const rootId = reuseTextNode ? nodeId : nanoid();
            const textIds = Array.from({ length: textCount }, () => nanoid());
            const rootNode: CanvasNodeData = {
                id: rootId,
                type: CanvasNodeType.Text,
                title: prompt.slice(0, 32) || "Generated Text",
                position: reuseTextNode ? sourceNode.position : { x: parentPosition.x + parentConfig.width + 96, y: parentPosition.y + parentConfig.height / 2 - textConfig.height / 2 },
                width: reuseTextNode ? sourceNode.width : textConfig.width,
                height: reuseTextNode ? sourceNode.height : textConfig.height,
                metadata: {
                    prompt,
                    status: NODE_STATUS_LOADING,
                    fontSize: 14,
                    model: generationConfig.model,
                    textCount,
                    texts: textIds.map((id) => ({ id, status: NODE_STATUS_LOADING, content: "" })),
                    primaryTextId: textIds[0],
                },
            };
            run.pendingChildIds = [rootId];
            setNodes((prev) =>
                reuseTextNode
                    ? prev.map((node) => (node.id === nodeId ? { ...node, ...rootNode } : node))
                    : [...prev.map((node) => (node.id === nodeId && isConfigNode ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)), rootNode],
            );
            if (!reuseTextNode) setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: nodeId, toNodeId: rootId }]);
            setSelectedNodeIds(new Set([nodeId]));
            setSelectedConnectionId(null);
            setDialogNodeId(nodeId);

            const controller = rootId === nodeId ? runController : startGenerationRequest(rootId, nodeId, nodeId, runController);
            // What actually went out goes on the node the user pressed, because that is the node whose
            // prompt the panel shows: the composition happened to *that* draft, not to the answer's.
            setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, sentPrompt: effectivePrompt } } : node)));
            const results = await Promise.all(
                textIds.map(async (textId): Promise<CanvasNodeText | null> => {
                    try {
                        // The agent answers as it goes, so the node fills in while it talks.
                        const content = await requestPromptChat(
                            nodeAgent(nodeId),
                            generationConfig,
                            { prompt: effectivePrompt, images: generationContext.referenceImages },
                            {
                                signal: controller.signal,
                                onDelta: (text) =>
                                    setNodes((prev) =>
                                        prev.map((node) =>
                                            node.id === rootId
                                                ? {
                                                      ...node,
                                                      metadata: {
                                                          ...node.metadata,
                                                          ...(node.metadata?.primaryTextId === textId ? { content: text } : {}),
                                                          texts: node.metadata?.texts?.map((item) => (item.id === textId ? { ...item, content: text } : item)),
                                                      },
                                                  }
                                                : node,
                                        ),
                                    ),
                            },
                        );
                        setNodes((prev) =>
                            prev.map((node) =>
                                node.id === rootId
                                    ? {
                                          ...node,
                                          metadata: {
                                              ...node.metadata,
                                              ...(node.metadata?.primaryTextId === textId ? { content } : {}),
                                              texts: node.metadata?.texts?.map((item) => (item.id === textId ? { ...item, content, status: NODE_STATUS_SUCCESS } : item)),
                                          },
                                      }
                                    : node,
                            ),
                        );
                        return { id: textId, status: NODE_STATUS_SUCCESS, content } satisfies CanvasNodeText;
                    } catch (error) {
                        if (isGenerationCanceled(error)) return null;
                        const errorDetails = error instanceof Error ? error.message : t("canvas.runtime.generationFailed");
                        setNodes((prev) =>
                            prev.map((node) => (node.id === rootId ? { ...node, metadata: { ...node.metadata, texts: node.metadata?.texts?.map((item) => (item.id === textId ? { ...item, status: NODE_STATUS_ERROR, errorDetails } : item)) } } : node)),
                        );
                        return { id: textId, status: NODE_STATUS_ERROR, content: "", errorDetails } satisfies CanvasNodeText;
                    }
                }),
            );
            if (rootId !== nodeId) finishGenerationRequest(rootId, controller);
            if (controller.signal.aborted) return;
            const completedTexts = results.flatMap((item) => (item?.status === NODE_STATUS_SUCCESS ? [item] : []));
            const failedTexts = results.filter((item) => item?.status === NODE_STATUS_ERROR);
            const firstText = completedTexts[0];
            if (failedTexts.length) toast.error(firstText ? t("canvas.runtime.partialTextFailed") : failedTexts[0]?.errorDetails || t("canvas.runtime.generationFailed"));
            setNodes((prev) =>
                prev.map((node) => {
                    if (node.id === rootId) {
                        const primaryText = completedTexts.find((text) => text.id === node.metadata?.primaryTextId) || firstText;
                        return {
                            ...node,
                            metadata: {
                                ...node.metadata,
                                content: primaryText?.content || "",
                                texts: completedTexts,
                                primaryTextId: primaryText?.id,
                                status: primaryText ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR,
                                errorDetails: primaryText ? undefined : t("canvas.runtime.generationFailed"),
                            },
                        };
                    }
                    return node.id === nodeId && isConfigNode ? { ...node, metadata: { ...node.metadata, status: firstText ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR, errorDetails: firstText ? undefined : t("canvas.runtime.generationFailed") } } : node;
                }),
            );
        },
        [finishGenerationRequest, startGenerationRequest, t],
    );

    /**
     * Retry is not generate. It has no mode and spawns nothing: it re-runs one request against the
     * node that already exists, into the image slot that failed if there is one. The branches below
     * are the same four types, but each writes back in place, which is why they are short and why
     * this could not simply be folded into the dispatch above.
     */
    const retryNode = useCallback(
        async (node: CanvasNodeData) => {
            if (hasResumableVideoTask(node)) {
                await pollVideoNodeTask(node);
                return;
            }
            const sourceNode = findRetrySourceNode(node.id, nodesRef.current, connectionsRef.current) || node;
            const savedImageMetadata = node.type === CanvasNodeType.Image ? node.metadata : undefined;
            const hasSavedImageMetadata = Boolean(savedImageMetadata?.generationType);
            const generationConfig =
                hasSavedImageMetadata && savedImageMetadata
                    ? {
                          ...effectiveConfig,
                          model: savedImageMetadata.model || effectiveConfig.imageModel || effectiveConfig.model,
                          quality: savedImageMetadata.quality || effectiveConfig.quality,
                          size: savedImageMetadata.size || effectiveConfig.size,
                          background: savedImageMetadata.background ?? effectiveConfig.background,
                          params: savedImageMetadata.params,
                      }
                    : buildGenerationConfig(effectiveConfig, sourceNode, node.type === CanvasNodeType.Text ? "text" : node.type === CanvasNodeType.Video ? "video" : node.type === CanvasNodeType.Audio ? "audio" : "image");
            // A text node retries against the agent, which needs no configuration here.
            if (node.type !== CanvasNodeType.Text && !isAiConfigReady(generationConfig, generationConfig.model)) {
                openPreferences();
                return;
            }

            const context = hasSavedImageMetadata ? null : await hydrateNodeGenerationContext(buildNodeGenerationContext(sourceNode.id, nodesRef.current, connectionsRef.current, sourceNode.metadata?.prompt || node.metadata?.prompt || ""));
            if (context?.loras.length) generationConfig.params = { ...(generationConfig.params || {}), loras: context.loras };
            const prompt = (savedImageMetadata?.prompt || context?.prompt || "").trim();
            if (!prompt) {
                toast.warning(t("canvas.runtime.retryPromptMissing"));
                return;
            }
            const generationType = savedImageMetadata?.generationType;
            const useReferenceImages = generationType ? generationType === "edit" : Boolean(context?.referenceImages.length);
            const retryReferenceImages =
                hasSavedImageMetadata && savedImageMetadata ? await resolveMetadataReferences(savedImageMetadata) : useReferenceImages ? (context?.referenceImages.length ? context.referenceImages : sourceNodeReferenceImages(sourceNode)) : [];
            if (useReferenceImages && !retryReferenceImages) {
                toast.error(t("canvas.runtime.referenceMissing"));
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === node.id
                            ? {
                                  ...item,
                                  metadata: {
                                      ...item.metadata,
                                      status: item.metadata?.content ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR,
                                      errorDetails: item.metadata?.content ? undefined : t("canvas.runtime.referenceMissing"),
                                  },
                              }
                            : item,
                    ),
                );
                return;
            }
            const retryImages = retryReferenceImages || [];

            setRunningNodeId(node.id);
            setNodes((prev) =>
                prev.map((item) =>
                    item.id === node.id
                        ? {
                              ...item,
                              metadata: {
                                  ...item.metadata,
                                  status: NODE_STATUS_LOADING,
                                  errorDetails: undefined,
                              },
                          }
                        : item,
                ),
            );
            const controller = startGenerationRequest(node.id, sourceNode.id, node.id);

            try {
                if (node.type === CanvasNodeType.Text) {
                    if (!context) return;
                    const answer = await requestPromptChat(
                        nodeAgent(node.id),
                        generationConfig,
                        { prompt, images: context.referenceImages },
                        {
                            signal: controller.signal,
                            onDelta: (text) => setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, type: CanvasNodeType.Text, metadata: { ...item.metadata, content: text, status: NODE_STATUS_LOADING } } : item))),
                        },
                    );
                    setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, type: CanvasNodeType.Text, metadata: { ...item.metadata, content: answer, prompt, status: NODE_STATUS_SUCCESS } } : item)));
                    return;
                }
                if (node.type === CanvasNodeType.Video) {
                    await completeVideoNodeTask(
                        node.id,
                        generationConfig,
                        prompt,
                        retryImages,
                        controller.signal,
                        // A retry is the user pressing the button again: nobody is holding a turn open on
                        // whether it started, and nobody asked to be told how it went.
                        {
                            extra: {
                                size: generationConfig.size,
                                seconds: generationConfig.videoSeconds,
                                vquality: generationConfig.vquality,
                                generateAudio: generationConfig.videoGenerateAudio,
                                watermark: generationConfig.videoWatermark,
                                videoMode: generationConfig.videoMode,
                            },
                            videos: context?.referenceVideos || [],
                            audios: context?.referenceAudios || [],
                        },
                    );
                    return;
                }
                if (node.type === CanvasNodeType.Audio) {
                    const audio = await requestAudioGeneration(generationConfig, prompt, {
                        signal: controller.signal,
                        onRun: (runId) => setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, audioRunId: runId } } : item))),
                        onProgress: (run) => setRunStepProgress(node.id, run.progress),
                    });
                    setNodes((prev) =>
                        prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, ...audioMetadata(audio), prompt, ...buildAudioGenerationMetadata(generationConfig), audioRunId: undefined, stepProgress: undefined } } : item)),
                    );
                    return;
                }

                const image = useReferenceImages
                    ? await requestEdit(generationConfig, prompt, retryImages, {
                          signal: controller.signal,
                          onPrompt: (sent) => setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, sentPrompt: sent } } : item))),
                      })
                    : await requestGeneration(generationConfig, prompt, {
                          signal: controller.signal,
                          onPrompt: (sent) => setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, sentPrompt: sent } } : item))),
                      });
                const uploadedImage = image;
                const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
                const imageSize = fitNodeSize(uploadedImage.width, uploadedImage.height, imageConfig.width, imageConfig.height);
                const generationMetadata = savedImageMetadata?.generationType
                    ? {
                          generationType: savedImageMetadata.generationType,
                          model: generationConfig.model,
                          size: generationConfig.size,
                          quality: generationConfig.quality,
                          ...(generationConfig.background ? { background: generationConfig.background } : {}),
                          references: savedImageMetadata.references,
                      }
                    : buildImageGenerationMetadata(useReferenceImages ? "edit" : "generation", generationConfig, retryImages);
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id !== node.id
                            ? item
                            : {
                                  ...item,
                                  type: CanvasNodeType.Image,
                                  ...imageSize,
                                  metadata: { ...item.metadata, ...imageMetadata(uploadedImage), prompt, ...generationMetadata },
                              },
                    ),
                );
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.runtime.generationFailed");
                toast.error(errorDetails);
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === node.id
                            ? {
                                  ...item,
                                  metadata: {
                                      ...item.metadata,
                                      status: item.metadata?.content ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR,
                                      errorDetails: item.metadata?.content ? undefined : errorDetails,
                                      ...(isVideoTaskFailed(error) && item.type === CanvasNodeType.Video ? { videoTaskId: undefined } : {}),
                                  },
                              }
                            : item,
                    ),
                );
            } finally {
                finishGenerationRequest(node.id, controller);
                setRunningNodeId(null);
            }
        },
        [completeVideoNodeTask, effectiveConfig, finishGenerationRequest, isAiConfigReady, openPreferences, pollVideoNodeTask, setRunStepProgress, startGenerationRequest, t],
    );

    /**
     * Resume the run an audio node was waiting on when the page went away.
     *
     * This is the reason audio was the first node migrated: the gateway keeps the run, so the canvas
     * only has to reattach to it. Nothing is re-submitted, and the same step ring is driven from the
     * run's own progress.
     */
    const pollAudioRun = useCallback(
        async (node: CanvasNodeData, silent = false) => {
            const runId = node.metadata?.audioRunId;
            if (!runId || node.metadata?.content || audioPollIdsRef.current.has(node.id)) return;
            audioPollIdsRef.current.add(node.id);
            let controller: AbortController | undefined;
            try {
                const generationConfig = buildGenerationConfig(effectiveConfig, node, "audio");
                const requestConfig = resolveModelRequestConfig(generationConfig, generationConfig.model);
                if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                    if (silent) {
                        setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails: t("workbench.configFirst") } } : item)));
                        return;
                    }
                    openPreferences();
                    return;
                }
                setRunningNodeId(node.id);
                setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined } } : item)));
                controller = startGenerationRequest(node.id, node.id, node.id);
                const finished = await waitForRun(generationConfig, runId, {
                    signal: controller.signal,
                    onProgress: (run) => setRunStepProgress(node.id, run.progress),
                    // Watching a run must not kill it: the page leaving is exactly the case this exists for.
                    cancelOnAbort: false,
                });
                const audio = await generatedAudio(requestConfig, finished);
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === node.id ? { ...item, metadata: { ...item.metadata, ...audioMetadata(audio), prompt: item.metadata?.prompt, ...buildAudioGenerationMetadata(generationConfig), audioRunId: undefined, stepProgress: undefined } } : item,
                    ),
                );
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.runtime.generationFailed");
                if (!silent) toast.error(errorDetails);
                setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails, audioRunId: undefined, stepProgress: undefined } } : item)));
            } finally {
                if (controller) finishGenerationRequest(node.id, controller);
                setRunningNodeId((current) => (current === node.id ? null : current));
                audioPollIdsRef.current.delete(node.id);
            }
        },
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, openPreferences, setNodes, setRunStepProgress, setRunningNodeId, startGenerationRequest, t],
    );

    /**
     * Resume the run an image node was waiting on when the page went away.
     *
     * The node was left loading and the run kept going, so this is the same fill the live request would
     * have done — with the artifact read from the run that finished without us.
     */
    const pollImageRun = useCallback(
        async (node: CanvasNodeData, silent = false) => {
            const runId = node.metadata?.imageRunId;
            if (!runId || node.metadata?.content || imagePollIdsRef.current.has(node.id)) return;
            imagePollIdsRef.current.add(node.id);
            let controller: AbortController | undefined;
            try {
                const generationConfig = buildGenerationConfig(effectiveConfig, node, "image");
                if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                    if (silent) {
                        setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails: t("workbench.configFirst") } } : item)));
                        return;
                    }
                    openPreferences();
                    return;
                }
                const requestConfig = resolveModelRequestConfig(generationConfig, generationConfig.model);
                setRunningNodeId(node.id);
                setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined } } : item)));
                controller = startGenerationRequest(node.id, node.id, node.id);
                const finished = await waitForRun(requestConfig, runId, {
                    signal: controller.signal,
                    onProgress: (run) => setRunStepProgress(node.id, run.progress),
                    // Watching a run must not kill it: the page leaving is exactly the case this exists for.
                    cancelOnAbort: false,
                });
                const image = await generatedImage(requestConfig, finished, { signal: controller.signal });
                await fillImage(node.id, image);
                setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_SUCCESS, errorDetails: undefined, imageRunId: undefined, stepProgress: undefined } } : item)));
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.runtime.generationFailed");
                if (!silent) toast.error(errorDetails);
                setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails, imageRunId: undefined, stepProgress: undefined } } : item)));
            } finally {
                if (controller) finishGenerationRequest(node.id, controller);
                setRunningNodeId((current) => (current === node.id ? null : current));
                imagePollIdsRef.current.delete(node.id);
            }
        },
        [effectiveConfig, fillImage, finishGenerationRequest, isAiConfigReady, openPreferences, setNodes, setRunStepProgress, setRunningNodeId, startGenerationRequest, t],
    );

    return { runImageGeneration, runVideoGeneration, runAudioGeneration, runTextGeneration, retryNode, pollAudioRun, pollImageRun };
}
