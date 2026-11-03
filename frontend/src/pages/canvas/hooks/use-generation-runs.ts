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
import { resolveModelRequestConfig, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { imageToDataUrl, type UploadedImage } from "@/services/image-storage";
import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { audioMetadata, buildAudioGenerationMetadata, buildImageGenerationMetadata, imageMetadata } from "@/lib/canvas/canvas-node-factory";
import { buildGenerationConfig, failedWatch, generationReferenceUrls, isGenerationCanceled } from "@/lib/canvas/canvas-generation-helpers";
import { NODE_STATUS_ERROR, NODE_STATUS_LOADING, NODE_STATUS_SUCCESS } from "@/lib/canvas/canvas-node-status";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeText } from "@/types/canvas";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import type { NodeGenerationContext } from "@/components/canvas/canvas-node-generation";
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
    generationContext: NodeGenerationContext;
    runController: AbortController;
    /**
     * Filled in by whichever mode ran, so the caller's `catch` can put the nodes it created into the
     * error state. It has to be mutable and it has to survive the mode returning early, which is why
     * it is a field on the run rather than a return value.
     */
    /**
     * The agent that asked for this generation, if one did. It rides along to the run, which is where the
     * server keeps "who is waiting to be told" — the tool call that started this is answered long before
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
 * above and the `catch` in the caller. Each drives its own request shape — an image request, a polled
 * video task, a single audio clip, a streamed text answer — and stamps the outcome onto the node it was
 * pressed on: generating replaces that node's content (#77), and a variant is a second node the user
 * makes.
 */
export function useGenerationRuns(deps: GenerationRunDeps) {
    const { setNodes, setSelectedNodeIds, setSelectedConnectionId, setDialogNodeId, nodesRef, setRunningNodeId, startGenerationRequest, finishGenerationRequest, completeVideoNodeTask } = deps;
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
    /**
     * What one poll tells the node about how far along it is.
     *
     * `resumed` is the server saying it re-attached to a run whose watching it had lost: the step count and
     * the previews came from the socket bound to the process that submitted, so there is nothing to show, and
     * the node says so instead of drawing a bar that will not move (#236). Ordinary runs are untouched — the
     * flag is only ever raised by a poll that reports one.
     */
    const setRunStepProgress = useCallback(
        (nodeId: string, progress?: RunProgress, resumed = false) => {
            const total = progress?.total && progress.total > 0 ? progress.total : 0;
            const step = Math.max(0, progress?.step || 0);
            const stepProgress = total > 0 ? { step: Math.min(total, step), total } : undefined;
            const progressUnavailable = Boolean(resumed) || undefined;
            setNodes((prev) =>
                prev.map((node) => {
                    if (node.id !== nodeId) return node;
                    if (node.metadata?.stepProgress === stepProgress && node.metadata?.progressUnavailable === progressUnavailable) return node;
                    return { ...node, metadata: { ...node.metadata, stepProgress, progressUnavailable } };
                }),
            );
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
            const { nodeId, prompt, effectivePrompt, generationConfig, generationContext, runController } = run;
            // An image node answers in place. A variant is a new node fed with this one through the
            // reference bar — whatever is connected here is what conditions the request, nothing else.
            let referenceImages = [...new Map(generationContext.referenceImages.map((image) => [image.id, image])).values()];
            if (generationConfig.imageMode === "inpaint") referenceImages = await withBoundMasks(referenceImages, nodesRef.current);
            const generationType = referenceImages.length ? ("edit" as const) : ("generation" as const);
            const generationMetadata = buildImageGenerationMetadata(generationType, generationConfig, referenceImages);
            const title = prompt.slice(0, 32) || "Generated Image";
            const metadata = {
                prompt,
                // What actually went out. The box holds what the user typed and the request is that plus
                // whatever is connected to it, so the difference is the panel's to show
                // (docs/decisions.md #185) — never the node's prompt, which stays the user's words.
                sentPrompt: effectivePrompt,
                status: NODE_STATUS_LOADING,
                ...generationMetadata,
            };

            setNodes((prev) =>
                prev.map((node) =>
                    node.id === nodeId
                        ? {
                              ...node,
                              // A node regenerated in place keeps its name when the box has no words to
                              // name it by: the request was the connected text, and "【Text 1】…" is not a
                              // title.
                              ...(prompt ? { title } : {}),
                              metadata: {
                                  ...node.metadata,
                                  ...metadata,
                                  content: undefined,
                                  storageKey: undefined,
                                  naturalWidth: undefined,
                                  naturalHeight: undefined,
                                  bytes: undefined,
                                  mimeType: undefined,
                                  // The picture they described is gone: a run that fails leaves the node with
                                  // no content and must not leave it claiming to hold one (#227).
                                  ...NO_MAKER,
                                  errorDetails: undefined,
                              },
                          }
                        : node,
                ),
            );
            setSelectedNodeIds(new Set([nodeId]));
            setSelectedConnectionId(null);
            setDialogNodeId(nodeId);

            const controller = startGenerationRequest(nodeId, nodeId, nodeId, runController);
            let hasSuccess = false;
            let hasFailure = false;
            let runEndedHere = false;
            let firstError = "";

            // One run, one picture: the server writes the artifact into the canvas and the node names it by
            // reference (#173, #180).
            try {
                const requestOptions = {
                    signal: controller.signal,
                    askedBy: run.askedBy,
                    onProgress: (state: Run) => setRunStepProgress(nodeId, state.progress),
                    // The id arrives at submission, before a single artifact exists: it is what a
                    // reload reattaches to.
                    onRun: (runId: string) => {
                        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, runId } } : node)));
                        run.start({ started: true, runId });
                    },
                };
                const result = referenceImages.length ? await requestEdit(generationConfig, effectivePrompt, referenceImages, requestOptions) : await requestGeneration(generationConfig, effectivePrompt, requestOptions);
                await fillImage(nodeId, result);
                hasSuccess = true;
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.runtime.generationFailed");
                if (!firstError) firstError = errorDetails;
                hasFailure = true;
                runEndedHere = failedWatch(error, t("canvas.runtime.generationFailed")).ended;
                failImage(nodeId, errorDetails);
            } finally {
                setRunStepProgress(nodeId, undefined);
            }
            if (controller.signal.aborted) return;
            if (hasFailure) {
                toast.error(hasSuccess ? t("canvas.runtime.partialFailed") : firstError || t("canvas.runtime.generationFailed"));
            }
            setNodes((prev) =>
                prev.map((node) =>
                    node.id === nodeId
                        ? {
                              ...node,
                              metadata: {
                                  ...node.metadata,
                                  status: hasSuccess ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR,
                                  errorDetails: hasSuccess ? undefined : t("canvas.runtime.allFailed"),
                                  // The id goes only when the run itself ended. A watch that could not ask
                                  // leaves it, so a reload picks the run up instead of paying for a second
                                  // one (#235).
                                  runId: hasFailure && !runEndedHere ? node.metadata?.runId : undefined,
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
            const { nodeId, prompt, effectivePrompt, generationConfig, generationContext, runController } = run;
            const title = prompt.slice(0, 32) || "Generated Video";
            const videoMetadata: CanvasNodeData["metadata"] = {
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
            };
            // The metadata is the run's to write, not the node's to keep: a `runId` left from an earlier
            // run would make a reload resume the wrong one.
            setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, ...(prompt ? { title } : {}), metadata: videoMetadata } : node)));
            const controller = startGenerationRequest(nodeId, nodeId, nodeId, runController);
            try {
                await completeVideoNodeTask(nodeId, generationConfig, effectivePrompt, generationContext.referenceImages, controller.signal, {
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
                finishGenerationRequest(nodeId, controller);
            }
        },
        [completeVideoNodeTask, finishGenerationRequest, startGenerationRequest, t],
    );

    const runAudioGeneration = useCallback(
        async (run: GenerationRun) => {
            const { nodeId, prompt, effectivePrompt, generationConfig, runController } = run;
            const title = prompt.slice(0, 32) || "Generated Audio";
            setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, ...(prompt ? { title } : {}), metadata: { prompt, sentPrompt: effectivePrompt, status: NODE_STATUS_LOADING, ...buildAudioGenerationMetadata(generationConfig) } } : node)));
            const controller = startGenerationRequest(nodeId, nodeId, nodeId, runController);
            try {
                const audio = await requestAudioGeneration(generationConfig, effectivePrompt, {
                    signal: controller.signal,
                    askedBy: run.askedBy,
                    // The id lands on the node before the first poll, so a reload can resume it.
                    onRun: (runId) => {
                        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, runId } } : node)));
                        run.start({ started: true, runId });
                    },
                    onProgress: (run) => setRunStepProgress(nodeId, run.progress, run.resumed),
                });
                setNodes((prev) =>
                    prev.map((node) =>
                        node.id === nodeId ? { ...node, metadata: { ...node.metadata, ...audioMetadata(audio), prompt, ...buildAudioGenerationMetadata(generationConfig), runId: undefined, stepProgress: undefined, progressUnavailable: undefined } } : node,
                    ),
                );
            } finally {
                finishGenerationRequest(nodeId, controller);
            }
        },
        [finishGenerationRequest, setNodes, setRunStepProgress, startGenerationRequest],
    );

    const runTextGeneration = useCallback(
        async (run: GenerationRun) => {
            const { nodeId, prompt, effectivePrompt, generationConfig, generationContext, runController } = run;
            // One prompt, one answer: a connected agent answers exactly one question, so a batch of texts
            // is no longer a thing (the count control went with the old text settings).
            const textIds = [nanoid()];
            // Asked from a text node, the answer belongs to that node: generating again rewrites it rather
            // than dropping a second one beside it.
            setNodes((prev) =>
                prev.map((node) =>
                    node.id === nodeId
                        ? {
                              ...node,
                              title: prompt.slice(0, 32) || "Generated Text",
                              metadata: {
                                  ...node.metadata,
                                  prompt,
                                  status: NODE_STATUS_LOADING,
                                  fontSize: 14,
                                  model: generationConfig.model,
                                  textCount: 1,
                                  texts: textIds.map((id) => ({ id, status: NODE_STATUS_LOADING, content: "" })),
                                  primaryTextId: textIds[0],
                              },
                          }
                        : node,
                ),
            );
            setSelectedNodeIds(new Set([nodeId]));
            setSelectedConnectionId(null);
            setDialogNodeId(nodeId);

            const controller = startGenerationRequest(nodeId, nodeId, nodeId, runController);
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
                                            node.id === nodeId
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
                                node.id === nodeId
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
                            prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, texts: node.metadata?.texts?.map((item) => (item.id === textId ? { ...item, status: NODE_STATUS_ERROR, errorDetails } : item)) } } : node)),
                        );
                        return { id: textId, status: NODE_STATUS_ERROR, content: "", errorDetails } satisfies CanvasNodeText;
                    }
                }),
            );

            if (controller.signal.aborted) return;
            const completedTexts = results.flatMap((item) => (item?.status === NODE_STATUS_SUCCESS ? [item] : []));
            const failedTexts = results.filter((item) => item?.status === NODE_STATUS_ERROR);
            const firstText = completedTexts[0];
            if (failedTexts.length) toast.error(firstText ? t("canvas.runtime.partialTextFailed") : failedTexts[0]?.errorDetails || t("canvas.runtime.generationFailed"));
            setNodes((prev) =>
                prev.map((node) => {
                    if (node.id === nodeId) {
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
                    return node;
                }),
            );
        },
        [finishGenerationRequest, startGenerationRequest, t],
    );

    /**
     * Resume the run an audio node was waiting on when the page went away.
     *
     * This is the reason audio was the first node migrated: the server keeps the run, so the canvas
     * only has to reattach to it. Nothing is re-submitted, and the same step ring is driven from the
     * run's own progress.
     */
    const pollAudioRun = useCallback(
        async (node: CanvasNodeData, silent = false) => {
            const runId = node.metadata?.runId;
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
                    onProgress: (run) => setRunStepProgress(node.id, run.progress, run.resumed),
                    // Watching a run must not kill it: the page leaving is exactly the case this exists for.
                    cancelOnAbort: false,
                });
                const audio = await generatedAudio(requestConfig, finished);
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === node.id
                            ? { ...item, metadata: { ...item.metadata, ...audioMetadata(audio), prompt: item.metadata?.prompt, ...buildAudioGenerationMetadata(generationConfig), runId: undefined, stepProgress: undefined, progressUnavailable: undefined } }
                            : item,
                    ),
                );
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const { ended, errorDetails } = failedWatch(error, t("canvas.runtime.generationFailed"));
                if (!silent) toast.error(errorDetails);
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails, runId: ended ? undefined : item.metadata?.runId, stepProgress: undefined, progressUnavailable: undefined } } : item,
                    ),
                );
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
            const runId = node.metadata?.runId;
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
                    onProgress: (run) => setRunStepProgress(node.id, run.progress, run.resumed),
                    // Watching a run must not kill it: the page leaving is exactly the case this exists for.
                    cancelOnAbort: false,
                });
                const image = await generatedImage(requestConfig, finished, { signal: controller.signal });
                await fillImage(node.id, image);
                setNodes((prev) =>
                    prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_SUCCESS, errorDetails: undefined, runId: undefined, stepProgress: undefined, progressUnavailable: undefined } } : item)),
                );
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const { ended, errorDetails } = failedWatch(error, t("canvas.runtime.generationFailed"));
                if (!silent) toast.error(errorDetails);
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails, runId: ended ? undefined : item.metadata?.runId, stepProgress: undefined, progressUnavailable: undefined } } : item,
                    ),
                );
            } finally {
                if (controller) finishGenerationRequest(node.id, controller);
                setRunningNodeId((current) => (current === node.id ? null : current));
                imagePollIdsRef.current.delete(node.id);
            }
        },
        [effectiveConfig, fillImage, finishGenerationRequest, isAiConfigReady, openPreferences, setNodes, setRunStepProgress, setRunningNodeId, startGenerationRequest, t],
    );

    return { runImageGeneration, runVideoGeneration, runAudioGeneration, runTextGeneration, pollAudioRun, pollImageRun };
}
