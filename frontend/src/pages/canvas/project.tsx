import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Bot } from "lucide-react";
import { saveAs } from "file-saver";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/kit/button";
import { Dialog } from "@/components/kit/dialog";
import { toast } from "@/components/kit/toast";
import { cancelRun, type RunRequest } from "@/services/api/runs";
import type { GenerateOptions, GenerateStart } from "@/lib/canvas/agent-generate";
import type { MoveOutcome, StopOutcome } from "@/lib/canvas/canvas-agent-tools";
import type { ModelCatalog } from "@/lib/canvas/node-model";
import { createVideoGenerationTask, waitForVideoGenerationTask, type VideoPreview } from "@/services/api/video";
import { acceptsInput, channelModelOf, modelContractOf, modelOptionLabel, useConfigStore, useEffectiveConfig, workflowModelOptions, type ModelAccepts, type ModelCapability } from "@/stores/use-config-store";
import { imageModeFor } from "@/lib/canvas/image-mode";
import { uploadImage } from "@/services/image-storage";
import { nanoid } from "nanoid";
import { type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { VIDEO_NODE_MAX_HEIGHT, VIDEO_NODE_MAX_WIDTH, applyGeneratedVideo } from "@/lib/canvas/canvas-generated-video";
import { NODE_STATUS_ERROR, NODE_STATUS_IDLE, NODE_STATUS_LOADING, NODE_STATUS_SUCCESS } from "@/lib/canvas/canvas-node-status";
import { useContentIngress } from "@/pages/canvas/hooks/use-content-ingress";
import type { ContentIngressDeps } from "@/pages/canvas/hooks/use-content-ingress";
import { useImageEditors } from "@/pages/canvas/hooks/use-image-editors";
import { useVideoEditors } from "@/pages/canvas/hooks/use-video-editors";
import type { NodeEditorDeps } from "@/pages/canvas/hooks/node-editor-deps";
import { useGenerationRuns } from "@/pages/canvas/hooks/use-generation-runs";
import type { GenerationRun, GenerationRunDeps } from "@/pages/canvas/hooks/use-generation-runs";
import { captureVideoFrame, type VideoFramePosition } from "@/lib/canvas/canvas-video-frame";

import { ActiveConnectionPath, ConnectionPath } from "@/components/canvas/canvas-connections";
import { CanvasConflictDialog } from "@/components/canvas/canvas-conflict-dialog";
import { CanvasNodeContextMenu } from "@/components/canvas/canvas-context-menu";

// The angle dialog drags in three.js (~136 kB gzip) for one control panel that most sessions
// never open, so it is loaded on demand instead of on first paint. The dynamic import keeps
// `three` out of the initial module graph; nothing else in the app imports it.
const CanvasNodeAngleDialog = lazy(() => import("@/components/canvas/canvas-node-angle-dialog").then((module) => ({ default: module.CanvasNodeAngleDialog })));
import { CanvasNodeCropDialog } from "@/components/canvas/canvas-node-crop-dialog";
import { CanvasNodeMaskEditDialog } from "@/components/canvas/canvas-node-mask-edit-dialog";
import { CanvasNodeOutpaintDialog } from "@/components/canvas/canvas-node-outpaint-dialog";
import { CanvasNodeMossLayoutDialog } from "@/components/canvas/canvas-node-moss-layout-dialog";
import { CanvasNodeSplitDialog } from "@/components/canvas/canvas-node-split-dialog";
import { buildNodeGenerationContext, describeEmptyInputs, hydrateNodeGenerationContext, inputsHoldingNothing } from "@/components/canvas/canvas-node-generation";
import { CanvasNodeHoverToolbar, CanvasNodeInfoModal } from "@/components/canvas/canvas-node-hover-toolbar";
import { CanvasSelectionToolbar } from "@/components/canvas/canvas-selection-toolbar";
import { InfiniteCanvas } from "@/components/canvas/infinite-canvas";
import { Minimap } from "@/components/canvas/canvas-mini-map";
import { CanvasNode } from "@/components/canvas/canvas-node";
import { LoraNodePanel } from "@/components/canvas/nodes/lora-node";
import { CanvasNodePromptPanel, type CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import { CanvasAgentPanel } from "@/components/canvas/canvas-agent-panel";
import { CanvasSidePanel } from "@/components/canvas/canvas-side-panel";
import { CanvasZoomControls } from "@/components/canvas/canvas-zoom-controls";
import { useCanvasAgentStore } from "@/stores/canvas/use-canvas-agent-store";
import { rememberLastCanvas } from "@/lib/canvas/last-canvas";
import { setActiveCanvas } from "@/services/canvas-files";
import { useCanvasStore, flushCanvasSaves } from "@/stores/canvas/use-canvas-store";
import { promptPatch } from "@/lib/canvas/node-prompt-field";
import { useCanvasAgentTools } from "@/pages/canvas/hooks/use-canvas-agent-tools";
import { buildNodeMentionReferences, getGroupResourceNodes, isCanvasReferenceNode, type CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { exportCanvas } from "@/lib/canvas/canvas-export";
import { applyNodeConfigPatch, createCanvasNode, imageMetadata } from "@/lib/canvas/canvas-node-factory";
import { recallNodeSettings } from "@/lib/canvas/node-settings-memory";
import {
    applyGroupSelection,
    applyUngroupSelection,
    canGroupSelectedNodes,
    canUngroupSelectedNodes,
    collectGroupMemberNodes,
    findGroupDropTarget,
    focusViewportForNode,
    getConnectionTargetAnchor,
    getGroupWrapRect,
    normalizeConnection,
    settleMoveMembership,
    snapNodesIntoGroup,
    withGroupMembers,
    withoutEmptiedGroups,
} from "@/lib/canvas/canvas-node-geometry";
import { adoptLegacyRunIds, audioExtension, buildGenerationConfig, failedWatch, hasResumableRun, hydrateCanvasImages, imageExtension, isGenerationCanceled, resetInterruptedGeneration, runWatchEnded } from "@/lib/canvas/canvas-generation-helpers";
import { videoRunMetadata } from "@/lib/canvas/video-run-metadata";
import { getNodeDefinition, isBuiltinNodeType } from "@/lib/canvas/node-registry";
import { registerBuiltinNodes } from "@/components/canvas/nodes/builtin-nodes";
import { confirm } from "@/components/kit/confirm";
import { CanvasRefreshShell } from "@/components/canvas/canvas-refresh-shell";
import { canvasMenuItems } from "@/components/canvas/canvas-menu";
import { CanvasTopBar } from "@/components/canvas/canvas-top-bar";
import { ConnectionCreateMenu, NodeCreateMenu, type PendingConnectionCreate } from "@/components/canvas/canvas-create-menus";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata, type CanvasNodeTypeId, type ConnectionHandle, type ContextMenuState, type Position, type SelectionBox, type ViewportTransform } from "@/types/canvas";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

// Register built-in nodes in the shared registry once when the module loads.
registerBuiltinNodes();

type CanvasClipboard = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
};

type ConnectionDropTarget = {
    nodeId: string | null;
    isNearNode: boolean;
};

type CanvasHistoryEntry = Pick<CanvasClipboard, "nodes" | "connections"> & {
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
};

type CanvasGenerationRequest = {
    targetNodeId: string;
    originNodeId: string;
    runningNodeId: string;
    controller: AbortController;
};

// The ten per-node editors used to be ten independent `string | null` states. That meant "which
// editor is open" had no single answer, so each reset path cleared a different subset: delete and
// clear closed five of the ten, Escape closed three. One nullable record instead makes "at most one
// editor is open" an invariant the compiler can see, and leaves the resets a single thing to clear.
type CanvasNodeTool = "info" | "crop" | "maskEdit" | "outpaint" | "mossLayout" | "split" | "angle";
type CanvasNodeToolState = { kind: CanvasNodeTool; nodeId: string } | null;

// Stable empty reference array prevents `... || []` from invalidating CanvasNode's React.memo on every render.
const EMPTY_REFERENCES: CanvasResourceReference[] = [];
const CONNECTION_HANDLE_HIT_RADIUS = 40;
const CONNECTION_NODE_HIT_PADDING = 32;

export default function CanvasPage() {
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
    }, []);

    if (!mounted) return <CanvasRefreshShell />;

    return <InfiniteCanvasPage />;
}

function measureFocusFrame(container: HTMLDivElement | null, nodeId: string) {
    if (!container) return {};
    const nodeRect = container.querySelector<HTMLElement>(`[data-node-id="${nodeId}"]`)?.getBoundingClientRect();
    const panelRect = container.querySelector<HTMLElement>(`[data-node-id="${nodeId}"] [data-node-panel]`)?.getBoundingClientRect();
    const toolbarRect = document.querySelector<HTMLElement>(`[data-node-toolbar="${nodeId}"]`)?.getBoundingClientRect();
    const below = nodeRect && panelRect ? panelRect.bottom - nodeRect.bottom : 0;
    const above = nodeRect && toolbarRect ? nodeRect.top - toolbarRect.top : 0;
    return { above, below };
}

function InfiniteCanvasPage() {
    const { t } = useTranslation();
    const params = useParams<{ id: string }>();
    const navigate = useNavigate();
    const projectId = params.id || "";
    const containerRef = useRef<HTMLDivElement>(null);
    const clipboardRef = useRef<CanvasClipboard | null>(null);
    const historyRef = useRef<{ past: CanvasHistoryEntry[]; future: CanvasHistoryEntry[] }>({ past: [], future: [] });
    const lastHistoryRef = useRef<CanvasHistoryEntry | null>(null);
    const historyCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const viewportSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const agentWindowSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** The debounced write above, so a page that is going away can run it before it is gone. */
    const agentWindowWriteRef = useRef<(() => void) | null>(null);
    const applyingHistoryRef = useRef(false);
    const historyPausedRef = useRef(false);
    const rafRef = useRef<number | null>(null);
    const nodeDraggingRef = useRef(false);
    const dragRef = useRef<{
        isDraggingNode: boolean;
        hasMoved: boolean;
        startX: number;
        startY: number;
        // Keyed by node id so drag frames look positions up in O(1) instead of scanning the array per node.
        initialSelectedNodes: Map<string, { x: number; y: number }>;
        movedIds: Set<string>;
    }>({
        isDraggingNode: false,
        hasMoved: false,
        startX: 0,
        startY: 0,
        initialSelectedNodes: new Map(),
        movedIds: new Set(),
    });

    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openPreferences = useConfigStore((state) => state.openPreferences);
    const ready = useCanvasStore((state) => state.ready);
    const loadCanvas = useCanvasStore((state) => state.loadCanvas);
    const updateProject = useCanvasStore((state) => state.updateProject);
    const clearSaveError = useCanvasStore((state) => state.clearSaveError);
    const checkForNewerCopy = useCanvasStore((state) => state.checkForNewerCopy);
    const currentProject = useCanvasStore((state) => state.projects.find((project) => project.id === projectId));
    const saveError = useCanvasStore((state) => state.saveErrors[projectId]);
    const theme = useCanvasTheme();
    const agentOpen = useCanvasAgentStore((state) => state.windows[projectId]?.open ?? false);
    const toggleAgent = useCanvasAgentStore((state) => state.toggle);
    const restoreAgentWindow = useCanvasAgentStore((state) => state.restore);
    const [nodes, setNodes] = useState<CanvasNodeData[]>([]);
    const [connections, setConnections] = useState<CanvasConnection[]>([]);
    const [viewport, setViewport] = useState<ViewportTransform>({ x: 0, y: 0, k: 1 });
    const [canvasTool, setCanvasTool] = useState<"select" | "pan">("pan");
    const [size, setSize] = useState({ width: 1200, height: 720 });
    const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
    const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
    const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
    const [connectingParams, setConnectingParams] = useState<ConnectionHandle | null>(null);
    const [connectionTargetNodeId, setConnectionTargetNodeId] = useState<string | null>(null);
    const [pendingConnectionCreate, setPendingConnectionCreate] = useState<PendingConnectionCreate | null>(null);
    const [mouseWorld, setMouseWorld] = useState<Position>({ x: 0, y: 0 });
    const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
    const [nodeCreatePosition, setNodeCreatePosition] = useState<Position | null>(null);
    const [runningNodeId, setRunningNodeId] = useState<string | null>(null);
    const [isMiniMapOpen, setIsMiniMapOpen] = useState(false);
    const [backgroundMode, setBackgroundMode] = useState<CanvasBackgroundMode>("lines");
    const [showImageInfo, setShowImageInfo] = useState(false);
    const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
    const [projectLoaded, setProjectLoaded] = useState(false);

    const [toolbarNodeId, setToolbarNodeId] = useState<string | null>(null);
    const [nodeImageSettingsOpen, setNodeImageSettingsOpen] = useState(false);
    const [dialogNodeId, setDialogNodeId] = useState<string | null>(null);
    const [activeNodeTool, setActiveNodeTool] = useState<CanvasNodeToolState>(null);
    const [previewNodeId, setPreviewNodeId] = useState<string | null>(null);
    const [hoverPreviewNodeId, setHoverPreviewNodeId] = useState<string | null>(null);
    const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
    const [isNodeDragging, setIsNodeDragging] = useState(false);
    const [isNodeResizing, setIsNodeResizing] = useState(false);
    const [dropTargetGroupId, setDropTargetGroupId] = useState<string | null>(null);
    const [referencePickerNodeId, setReferencePickerNodeId] = useState<string | null>(null);
    // The agent panel asking for a node: the canvas becomes clickable and the answer goes back to the panel.
    const [pickingForAgent, setPickingForAgent] = useState(false);
    const agentPickResolve = useRef<((nodeId: string | null) => void) | null>(null);

    const nodesRef = useRef(nodes);
    const connectionsRef = useRef(connections);
    const selectedNodeIdsRef = useRef(selectedNodeIds);
    const viewportRef = useRef(viewport);
    const focusAnimRef = useRef<number | null>(null);
    const generateNodeRef = useRef<((nodeId: string, mode: CanvasNodeGenerationMode, prompt: string, options?: GenerateOptions) => Promise<void>) | null>(null);
    const connectingParamsRef = useRef(connectingParams);
    const connectionTargetNodeIdRef = useRef(connectionTargetNodeId);
    const selectionBoxRef = useRef(selectionBox);
    const pendingConnectionCreateRef = useRef(pendingConnectionCreate);
    const generationRequestsRef = useRef(new Map<string, CanvasGenerationRequest>());
    const generationStepTimersRef = useRef(new Map<string, number>());
    const videoPollIdsRef = useRef(new Set<string>());

    // Opening an editor displaces whatever was open: there is only one slot to put it in.
    const openNodeTool = useCallback((kind: CanvasNodeTool, nodeId: string) => setActiveNodeTool({ kind, nodeId }), []);
    const closeNodeTool = useCallback(() => setActiveNodeTool(null), []);

    const createHistoryEntry = useCallback(
        (): CanvasHistoryEntry => ({
            nodes: nodesRef.current,
            connections: connectionsRef.current,
            backgroundMode,
            showImageInfo,
        }),
        [backgroundMode, showImageInfo],
    );

    const startGenerationRequest = useCallback((targetNodeId: string, originNodeId: string, runningId = originNodeId, controller = new AbortController()) => {
        const previous = generationRequestsRef.current.get(targetNodeId);
        if (previous?.controller !== controller) previous?.controller.abort("user-stop");
        const pendingClear = generationStepTimersRef.current.get(targetNodeId);
        if (pendingClear) {
            window.clearTimeout(pendingClear);
            generationStepTimersRef.current.delete(targetNodeId);
        }
        setNodes((prev) => prev.map((item) => (item.id === targetNodeId && item.metadata?.stepProgress ? { ...item, metadata: { ...item.metadata, stepProgress: undefined } } : item)));
        generationRequestsRef.current.set(targetNodeId, { targetNodeId, originNodeId, runningNodeId: runningId, controller });
        return controller;
    }, []);

    const finishGenerationRequest = useCallback((targetNodeId: string, controller: AbortController) => {
        const request = generationRequestsRef.current.get(targetNodeId);
        if (request?.controller !== controller) return;
        generationRequestsRef.current.delete(targetNodeId);
        if (!nodesRef.current.some((item) => item.id === targetNodeId && item.metadata?.stepProgress)) return;
        // Let the last segment light up and glow briefly before the ring fades out.
        setNodes((prev) =>
            prev.map((item) => {
                if (item.id !== targetNodeId || !item.metadata?.stepProgress) return item;
                const total = item.metadata.stepProgress.total;
                return { ...item, metadata: { ...item.metadata, stepProgress: { step: total, total, complete: true } } };
            }),
        );
        const timer = window.setTimeout(() => {
            generationStepTimersRef.current.delete(targetNodeId);
            setNodes((prev) => prev.map((item) => (item.id === targetNodeId && item.metadata?.stepProgress ? { ...item, metadata: { ...item.metadata, stepProgress: undefined } } : item)));
        }, 1450);
        generationStepTimersRef.current.set(targetNodeId, timer);
    }, []);

    const updateVideoPreview = useCallback((nodeId: string, preview: VideoPreview | null) => {
        setNodes((prev) =>
            prev.map((item) => {
                if (item.id !== nodeId) return item;
                const stepProgress = preview?.step != null && preview.total ? { step: preview.step, total: preview.total } : item.metadata?.stepProgress;
                return {
                    ...item,
                    metadata: {
                        ...item.metadata,
                        previewUrl: preview?.url,
                        previewMime: preview?.mime,
                        previewStep: preview?.step,
                        previewTotal: preview?.total,
                        stepProgress,
                    },
                };
            }),
        );
    }, []);

    const updateVideoSteps = useCallback((nodeId: string, steps: { step: number; total: number }) => {
        setNodes((prev) => prev.map((item) => (item.id === nodeId ? { ...item, metadata: { ...item.metadata, stepProgress: steps } } : item)));
    }, []);
    /**
     * Say that this run cannot report progress.
     *
     * A video's steps and previews come from ComfyUI's socket, which the server bound in the process that
     * submitted it. A run it re-attached to after a restart has neither, so the node says it is waiting
     * rather than showing a count that has stopped (#236).
     */
    const noteRunResumed = useCallback((nodeId: string, resumed: boolean) => {
        if (!resumed) return;
        setNodes((prev) => prev.map((item) => (item.id === nodeId && !item.metadata?.progressUnavailable ? { ...item, metadata: { ...item.metadata, progressUnavailable: true, stepProgress: undefined } } : item)));
    }, []);

    /** What a video run may be told beyond the request itself. */
    type CompleteVideoOptions = {
        /** The conversation to tell when the run ends (#225). */
        askedBy?: RunRequest["askedBy"];
        /** Called with the run id the moment it exists — what the tool's answer waits on. */
        started?: (runId: string) => void;
        extra?: CanvasNodeData["metadata"];
        videos?: ReferenceVideo[];
        audios?: ReferenceAudio[];
    };

    const completeVideoNodeTask = useCallback(
        async (nodeId: string, config: Parameters<typeof buildGenerationConfig>[0], prompt: string, images: Parameters<typeof createVideoGenerationTask>[2], signal: AbortSignal, options: CompleteVideoOptions = {}) => {
            const { askedBy, started, extra = {}, videos = [], audios = [] } = options;
            const task = await createVideoGenerationTask(config, prompt, images, { signal, videos, audios, askedBy });
            // The run is out, which is the one thing the agent holding the tool call needs: it is told
            // before the minutes of rendering, not after (#225).
            started?.(task.id);
            setNodes((prev) =>
                prev.map((item) =>
                    item.id === nodeId
                        ? {
                              ...item,
                              metadata: {
                                  ...item.metadata,
                                  runId: task.id,
                                  model: config.model,
                                  params: config.params,
                                  previewUrl: undefined,
                                  previewMime: undefined,
                                  previewStep: undefined,
                                  previewTotal: undefined,
                              },
                          }
                        : item,
                ),
            );
            const video = await waitForVideoGenerationTask(config, task, {
                signal,
                onPreview: (preview) => updateVideoPreview(nodeId, preview),
                onSteps: (steps) => updateVideoSteps(nodeId, steps),
                onPoll: (run) => noteRunResumed(nodeId, Boolean(run.resumed)),
            });
            setNodes((prev) =>
                prev.map((item) =>
                    item.id === nodeId ? applyGeneratedVideo(item, video, { prompt, model: config.model, ...extra, previewUrl: undefined, previewMime: undefined, previewStep: undefined, previewTotal: undefined, progressUnavailable: undefined }) : item,
                ),
            );
        },
        [noteRunResumed, updateVideoPreview, updateVideoSteps],
    );

    const pollVideoNodeTask = useCallback(
        async (node: CanvasNodeData, silent = false) => {
            const taskId = node.metadata?.runId;
            if (!taskId || node.metadata?.content || generationRequestsRef.current.has(node.id) || videoPollIdsRef.current.has(node.id)) return;
            videoPollIdsRef.current.add(node.id);
            let controller: AbortController | undefined;
            try {
                const generationConfig = buildGenerationConfig(effectiveConfig, node, "video");
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
                const video = await waitForVideoGenerationTask(
                    generationConfig,
                    { id: taskId, model: generationConfig.model },
                    {
                        signal: controller.signal,
                        onPreview: (preview) => updateVideoPreview(node.id, preview),
                        onSteps: (steps) => updateVideoSteps(node.id, steps),
                        onPoll: (run) => noteRunResumed(node.id, Boolean(run.resumed)),
                    },
                );
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === node.id
                            ? applyGeneratedVideo(item, video, {
                                  prompt: item.metadata?.prompt,
                                  ...videoRunMetadata(generationConfig),
                                  previewUrl: undefined,
                                  previewMime: undefined,
                                  previewStep: undefined,
                                  previewTotal: undefined,
                              })
                            : item,
                    ),
                );
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                // The run failing and the watch failing are two different things: only the first ends the
                // run, so only the first takes the id with it (#235).
                const { ended, errorDetails } = failedWatch(error, t("canvas.runtime.generationFailed"));
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
                                      ...(ended ? { runId: undefined } : {}),
                                      previewUrl: undefined,
                                      previewMime: undefined,
                                      previewStep: undefined,
                                      previewTotal: undefined,
                                      progressUnavailable: undefined,
                                  },
                              }
                            : item,
                    ),
                );
            } finally {
                videoPollIdsRef.current.delete(node.id);
                if (controller) {
                    finishGenerationRequest(node.id, controller);
                    setRunningNodeId((current) => (current === node.id ? null : current));
                }
            }
        },
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, noteRunResumed, openPreferences, startGenerationRequest, t, updateVideoPreview, updateVideoSteps],
    );

    const stopGenerationByRunningId = useCallback(
        (runningId: string) => {
            const affectedNodeIds = new Set<string>();
            generationRequestsRef.current.forEach((request) => {
                if (request.runningNodeId !== runningId && request.originNodeId !== runningId && request.targetNodeId !== runningId) return;
                request.controller.abort("user-stop");
                generationRequestsRef.current.delete(request.targetNodeId);
                const pendingClear = generationStepTimersRef.current.get(request.targetNodeId);
                if (pendingClear) {
                    window.clearTimeout(pendingClear);
                    generationStepTimersRef.current.delete(request.targetNodeId);
                }
                affectedNodeIds.add(request.targetNodeId);
                affectedNodeIds.add(request.originNodeId);
            });
            setRunningNodeId((current) => (current === runningId ? null : current));
            if (!affectedNodeIds.size) return;
            setNodes((prev) =>
                prev.map((node) =>
                    affectedNodeIds.has(node.id) && node.metadata?.status === NODE_STATUS_LOADING
                        ? {
                              ...node,
                              metadata: {
                                  ...node.metadata,
                                  status: NODE_STATUS_IDLE,
                                  errorDetails: undefined,
                                  stepProgress: undefined,
                              },
                          }
                        : node,
                ),
            );
        },
        [t],
    );

    const confirmStopGeneration = useCallback(
        (nodeId: string) => {
            confirm({
                title: t("canvas.runtime.stopTitle"),
                content: t("canvas.runtime.stopDescription"),
                okText: t("canvas.runtime.stop"),
                cancelText: t("canvas.runtime.continue"),
                danger: true,
                onOk: () => stopGenerationByRunningId(nodeId),
            });
        },
        [stopGenerationByRunningId, t],
    );

    /**
     * Stop one node's run for a tool, without the question the button asks, and say what that did.
     *
     * Two things a run can be here, and both have to end for a stop to mean anything:
     * - the watch this page holds. Aborting it is what puts the node back to idle instead of leaving it
     *   spinning, and for a run the page *submitted* it also cancels the run as it goes.
     * - the run itself, which is the server's. A watch the page picked up again after a reload deliberately
     *   does not cancel (`cancelOnAbort: false` — leaving the page must not kill a render), so the run is
     *   cancelled by its id as well. That is the one path every watcher shares, and a cancel for a run that has
     *   already ended is refused by the run's own record rather than being an error.
     *
     * The node's `runId` goes with the stop: the node is idle because the work is over, and a reload that
     * reattached to a run nobody is waiting for would start the "waiting" line again.
     */
    const stopNodeRun = useCallback(
        async (nodeId: string): Promise<StopOutcome> => {
            const node = nodesRef.current.find((candidate) => candidate.id === nodeId);
            if (!node) return { running: false };
            const runId = node.metadata?.runId;
            const watched = Array.from(generationRequestsRef.current.values()).some((request) => request.runningNodeId === nodeId || request.originNodeId === nodeId || request.targetNodeId === nodeId);
            if (!runId && !watched) return { running: false };

            stopGenerationByRunningId(nodeId);
            let cancel: StopOutcome["cancel"];
            let reason: string | undefined;
            if (runId) {
                const mode: CanvasNodeGenerationMode = node.type === CanvasNodeType.Video ? "video" : node.type === CanvasNodeType.Audio ? "audio" : "image";
                try {
                    const run = await cancelRun(buildGenerationConfig(effectiveConfig, node, mode), runId);
                    cancel = run.status === "cancelled" ? "cancelled" : "finished";
                } catch (error) {
                    cancel = "unknown";
                    reason = error instanceof Error ? error.message : String(error);
                }
            }
            setNodes((prev) =>
                prev.map((item) =>
                    item.id === nodeId && item.metadata?.runId === runId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_IDLE, errorDetails: undefined, runId: undefined, stepProgress: undefined, progressUnavailable: undefined } } : item,
                ),
            );
            return { running: true, ...(cancel ? { cancel } : {}), ...(reason ? { reason } : {}) };
        },
        [effectiveConfig, stopGenerationByRunningId],
    );

    useEffect(() => {
        if (!ready) return;
        setProjectLoaded(false);
        let live = true;

        const restore = async () => {
            // The document is on disk now, so opening one is a request. A canvas that is not there is
            // not an error to report: the id in the address bar is stale, and `/` knows what to do.
            const project = await loadCanvas(projectId).catch(() => null);
            if (!live) return;
            if (!project) {
                navigate("/", { replace: true });
                return;
            }
            // Remember where the browser was, so `/` can send it back here, and tell the media layer
            // which canvas its `files/<name>` references belong to.
            rememberLastCanvas(projectId);
            setActiveCanvas(projectId);

            // A canvas written before `runId` had one name is read into it first, so a run that was in flight
            // then is still picked up (#235).
            const restoredNodes = await hydrateCanvasImages(resetInterruptedGeneration(adoptLegacyRunIds(project.nodes)));
            setNodes(restoredNodes);
            setConnections(project.connections);
            setBackgroundMode(project.backgroundMode);
            setShowImageInfo(project.showImageInfo || false);
            setViewport(project.viewport);
            // The panel's window is part of the document, so it comes back with the viewport — the
            // conversation and the corner it was left in, not a default.
            restoreAgentWindow(projectId, project.agent);
            historyRef.current = { past: [], future: [] };
            if (historyCommitTimerRef.current) {
                clearTimeout(historyCommitTimerRef.current);
                historyCommitTimerRef.current = null;
            }
            lastHistoryRef.current = {
                nodes: restoredNodes,
                connections: project.connections,
                backgroundMode: project.backgroundMode,
                showImageInfo: project.showImageInfo || false,
            };
            setHistoryState({ canUndo: false, canRedo: false });
            if (live) setProjectLoaded(true);
        };
        void restore();
        return () => {
            live = false;
        };
    }, [ready, loadCanvas, navigate, projectId]);

    useEffect(() => {
        if (!projectLoaded || applyingHistoryRef.current || historyPausedRef.current) return;
        const next = createHistoryEntry();
        const previous = lastHistoryRef.current;
        if (previous?.nodes === next.nodes && previous.connections === next.connections && previous.backgroundMode === next.backgroundMode && previous.showImageInfo === next.showImageInfo) return;

        if (historyCommitTimerRef.current) clearTimeout(historyCommitTimerRef.current);
        historyCommitTimerRef.current = setTimeout(() => {
            const current = createHistoryEntry();
            const last = lastHistoryRef.current;
            if (!last) return;
            historyRef.current.past = [...historyRef.current.past.slice(-49), last];
            historyRef.current.future = [];
            setHistoryState({ canUndo: true, canRedo: false });
            lastHistoryRef.current = current;
            historyCommitTimerRef.current = null;
        }, 180);

        return () => {
            if (historyCommitTimerRef.current) {
                clearTimeout(historyCommitTimerRef.current);
                historyCommitTimerRef.current = null;
            }
        };
    }, [backgroundMode, connections, createHistoryEntry, nodes, projectLoaded, showImageInfo]);

    useEffect(() => {
        if (!projectLoaded || historyPausedRef.current) return;
        updateProject(projectId, { nodes, connections, backgroundMode, showImageInfo });
    }, [backgroundMode, connections, nodes, projectId, projectLoaded, showImageInfo, updateProject]);

    useEffect(() => {
        if (!dialogNodeId) setNodeImageSettingsOpen(false);
    }, [dialogNodeId]);

    useEffect(() => {
        if (!projectLoaded) return;
        if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
        viewportSaveTimerRef.current = setTimeout(() => {
            updateProject(projectId, { viewport: viewportRef.current });
            viewportSaveTimerRef.current = null;
        }, 500);
        return () => {
            if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
        };
    }, [projectId, projectLoaded, updateProject, viewport]);

    /**
     * The agent's window is document state like the viewport, so it is written back the same way.
     *
     * Subscribed rather than selected: a drag or a resize changes this store on every pointer frame, and
     * selecting the whole window here would re-render the whole canvas for each one. The page reads only
     * `open` (for the toggle button); the geometry is the panel's. Open and closed are written at once —
     * that is a decision, not a gesture — while geometry waits for the pointer to settle, which is the
     * same bargain the viewport makes.
     */
    useEffect(() => {
        if (!projectLoaded) return;
        const initial = useCanvasAgentStore.getState().windows[projectId];
        /** What is already in the document this effect last wrote, so a restore is not saved back. */
        let written = JSON.stringify(initial ?? null);
        let open = initial?.open ?? false;
        const write = () => {
            if (agentWindowSaveTimerRef.current) {
                clearTimeout(agentWindowSaveTimerRef.current);
                agentWindowSaveTimerRef.current = null;
            }
            const next = useCanvasAgentStore.getState().windows[projectId];
            if (!next) return;
            const encoded = JSON.stringify(next);
            if (encoded === written) return;
            written = encoded;
            updateProject(projectId, { agent: next });
        };
        const unsubscribe = useCanvasAgentStore.subscribe((state) => {
            const next = state.windows[projectId];
            if (!next) return;
            if (next.open !== open) {
                open = next.open;
                write();
                return;
            }
            if (agentWindowSaveTimerRef.current) clearTimeout(agentWindowSaveTimerRef.current);
            agentWindowSaveTimerRef.current = setTimeout(write, 500);
        });
        agentWindowWriteRef.current = write;
        return () => {
            unsubscribe();
            agentWindowWriteRef.current = null;
            // Leaving the canvas must not drop the last frame of a drag: write it now and let the save
            // queue coalesce it with whatever else is waiting.
            write();
        };
    }, [projectId, projectLoaded, updateProject]);

    // A refresh takes the page away in the middle of whatever debounce is pending. The window is part
    // of the document, so the last drag is written here and pushed out with the queue — the same answer
    // #177 gave the saves themselves.
    useEffect(() => {
        const flush = () => {
            agentWindowWriteRef.current?.();
            flushCanvasSaves();
        };
        window.addEventListener("pagehide", flush);
        return () => window.removeEventListener("pagehide", flush);
    }, []);

    // The tab coming back is exactly when the mistake shows up: somebody opened a second tab, worked
    // there, and switched to this one. One GET of the entry says whether the file moved on (#158).
    useEffect(() => {
        if (!projectLoaded) return;
        const check = () => {
            if (document.visibilityState === "visible") void checkForNewerCopy(projectId);
        };
        window.addEventListener("focus", check);
        document.addEventListener("visibilitychange", check);
        return () => {
            window.removeEventListener("focus", check);
            document.removeEventListener("visibilitychange", check);
        };
    }, [checkForNewerCopy, projectId, projectLoaded]);

    // A save that failed, or lost the version race, is said out loud once. Silence here would mean
    // edits disappearing while the canvas looks perfectly saved.
    useEffect(() => {
        if (!saveError) return;
        toast.error(saveError);
        clearSaveError(projectId);
    }, [clearSaveError, projectId, saveError]);

    useLayoutEffect(() => {
        nodesRef.current = nodes;
        connectionsRef.current = connections;
        selectedNodeIdsRef.current = selectedNodeIds;
        viewportRef.current = viewport;
        connectingParamsRef.current = connectingParams;
        connectionTargetNodeIdRef.current = connectionTargetNodeId;
        pendingConnectionCreateRef.current = pendingConnectionCreate;
    }, [nodes, connections, selectedNodeIds, viewport, connectingParams, connectionTargetNodeId, pendingConnectionCreate]);

    useLayoutEffect(() => {
        selectionBoxRef.current = selectionBox;
    }, [selectionBox]);

    useEffect(() => {
        if (!projectLoaded) return;
        const el = containerRef.current;
        if (!el) return;

        const updateSize = () => {
            const rect = el.getBoundingClientRect();
            setSize({ width: rect.width, height: rect.height });
        };

        updateSize();
        const resizeObserver = new ResizeObserver(updateSize);
        resizeObserver.observe(el);
        return () => resizeObserver.disconnect();
    }, [projectLoaded]);

    const screenToCanvas = useCallback((clientX: number, clientY: number) => {
        const rect = containerRef.current?.getBoundingClientRect();
        const currentViewport = viewportRef.current;
        const localX = clientX - (rect?.left || 0);
        const localY = clientY - (rect?.top || 0);

        return {
            x: (localX - currentViewport.x) / currentViewport.k,
            y: (localY - currentViewport.y) / currentViewport.k,
        };
    }, []);

    const getCanvasCenter = useCallback(() => {
        const rect = containerRef.current?.getBoundingClientRect();
        return screenToCanvas((rect?.left || 0) + (rect?.width || size.width) / 2, (rect?.top || 0) + (rect?.height || size.height) / 2);
    }, [screenToCanvas, size.height, size.width]);

    const setConnecting = useCallback((next: ConnectionHandle | null) => {
        connectingParamsRef.current = next;
        setConnectingParams(next);
        if (!next) {
            connectionTargetNodeIdRef.current = null;
            setConnectionTargetNodeId(null);
        }
    }, []);

    const keepNodeToolbar = useCallback(
        (nodeId: string) => {
            if (nodeDraggingRef.current || nodeImageSettingsOpen || !selectedNodeIdsRef.current.has(nodeId)) return;
            setToolbarNodeId(nodeId);
        },
        [nodeImageSettingsOpen],
    );

    const hideNodeToolbar = useCallback(() => {}, []);

    /**
     * Add one connection the way a drag does: normalized by the canvas's own rules, and never twice.
     *
     * Returns whether the two nodes may be connected at all — nothing may be wired into a group.
     */
    const addConnection = useCallback((firstNodeId: string, secondNodeId: string, _firstHandleType: "source" | "target"): boolean => {
        const connection = normalizeConnection(firstNodeId, secondNodeId, nodesRef.current);
        if (!connection) return false;
        const { fromNodeId, toNodeId } = connection;
        const exists = connectionsRef.current.some((conn) => conn.fromNodeId === fromNodeId && conn.toNodeId === toNodeId);
        // `nanoid()`, not a timestamp: the agent wires several nodes in one batch, so three connections can
        // be made inside one millisecond — and a shared id is not a cosmetic problem, since selecting or
        // deleting a connection goes by id (#205).
        if (!exists) {
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId, toNodeId }]);
        }
        return true;
    }, []);

    const connectNodes = useCallback(
        (current: ConnectionHandle, targetNodeId: string) => {
            if (current.nodeId === targetNodeId) return;
            if (!addConnection(current.nodeId, targetNodeId, current.handleType)) {
                toast.warning(t("canvas.runtime.connectionRefused"));
                return;
            }
            setContextMenu(null);
        },
        [addConnection, t],
    );

    const createConnectedNode = useCallback(
        (type: string, pending: PendingConnectionCreate) => {
            const newNode = createCanvasNode(type, pending.position, recallNodeSettings(type) || undefined);
            const insertBefore = Boolean(getNodeDefinition(type)?.insertBefore);
            // A node inserted upstream (a LoRA card, say) is created before the current node; the current node must not be treated as its upstream.
            const connection = insertBefore ? normalizeConnection(newNode.id, pending.connection.nodeId, [...nodesRef.current, newNode]) : normalizeConnection(pending.connection.nodeId, newNode.id, [...nodesRef.current, newNode]);
            if (!connection) {
                toast.warning(t("canvas.runtime.connectionRefused"));
                return;
            }
            setNodes((prev) => [...prev, newNode]);
            setConnections((prev) => [...prev, { id: nanoid(), ...connection }]);
            setSelectedNodeIds(new Set([newNode.id]));
            setSelectedConnectionId(null);
            if (insertBefore || (type !== CanvasNodeType.Text && type !== CanvasNodeType.Audio)) setDialogNodeId(newNode.id);
            setPendingConnectionCreate(null);
            setConnecting(null);
        },
        [effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size, setConnecting, t],
    );

    const cancelPendingConnectionCreate = useCallback(() => {
        setPendingConnectionCreate(null);
        setConnecting(null);
    }, [setConnecting]);

    const getConnectionDropTarget = useCallback(
        (clientX: number, clientY: number, current: ConnectionHandle): ConnectionDropTarget => {
            const world = screenToCanvas(clientX, clientY);
            const scale = Math.max(viewportRef.current.k, 0.05);
            const padding = CONNECTION_NODE_HIT_PADDING / scale;
            const handleRadius = CONNECTION_HANDLE_HIT_RADIUS / scale;
            let isNearNode = false;
            let bestNodeId: string | null = null;
            let bestPriority = Number.POSITIVE_INFINITY;

            [...nodesRef.current].reverse().forEach((node) => {
                const anchor = getConnectionTargetAnchor(node, current);
                const dx = world.x - anchor.x;
                const dy = world.y - anchor.y;
                const hitsHandle = dx * dx + dy * dy <= handleRadius * handleRadius;
                const hitsInside = world.x >= node.position.x && world.x <= node.position.x + node.width && world.y >= node.position.y && world.y <= node.position.y + node.height;
                const hitsExpanded = world.x >= node.position.x - padding && world.x <= node.position.x + node.width + padding && world.y >= node.position.y - padding && world.y <= node.position.y + node.height + padding;

                if (!hitsHandle && !hitsInside && !hitsExpanded) return;
                isNearNode = true;
                if (node.id === current.nodeId || !normalizeConnection(current.nodeId, node.id, nodesRef.current)) return;

                const priority = hitsInside ? 0 : hitsHandle ? 1 : 2;
                if (priority < bestPriority) {
                    bestNodeId = node.id;
                    bestPriority = priority;
                }
            });

            return { nodeId: bestNodeId, isNearNode };
        },
        [screenToCanvas],
    );

    const viewBounds = useMemo(() => {
        const padding = 280;
        const rect = containerRef.current?.getBoundingClientRect();
        const width = rect?.width || size.width;
        const height = rect?.height || size.height;
        const left = -viewport.x / viewport.k - padding;
        const top = -viewport.y / viewport.k - padding;
        return { left, top, right: left + width / viewport.k + padding * 2, bottom: top + height / viewport.k + padding * 2 };
        // `nodes` keeps the container rect re-read on node changes, matching the previous behaviour when the container resizes without a size update.
    }, [nodes, size.height, size.width, viewport.k, viewport.x, viewport.y]);

    const visibleNodes = useMemo(
        () => nodes.filter((node) => node.position.x + node.width > viewBounds.left && node.position.x < viewBounds.right && node.position.y + node.height > viewBounds.top && node.position.y < viewBounds.bottom),
        [nodes, viewBounds],
    );

    const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);

    // Connections are culled like nodes; a cubic curve stays inside its control-point hull, so endpoint bounds widened by the curvature is a safe test.
    const visibleConnections = useMemo(
        () =>
            connections.flatMap((connection) => {
                const from = nodeById.get(connection.fromNodeId);
                const to = nodeById.get(connection.toNodeId);
                if (!from || !to) return [];
                const startX = from.position.x + from.width;
                const startY = from.position.y + from.height / 2;
                const endX = to.position.x;
                const endY = to.position.y + to.height / 2;
                const curvature = Math.max(Math.abs(endX - startX) * 0.5, 50);
                const inView = Math.max(startX + curvature, endX) > viewBounds.left && Math.min(startX, endX - curvature) < viewBounds.right && Math.max(startY, endY) > viewBounds.top && Math.min(startY, endY) < viewBounds.bottom;
                return inView ? [{ connection, from, to }] : [];
            }),
        [connections, nodeById, viewBounds],
    );
    // The toolbar follows a single selected node selected by click, creation, marquee, or keyboard.
    // It stays hidden for multi-selection and while isNodeDragging is true.
    const singleSelectedNodeId = selectedNodeIds.size === 1 ? Array.from(selectedNodeIds)[0] : null;
    const toolbarNode = (toolbarNodeId ? nodeById.get(toolbarNodeId) || null : null) || (singleSelectedNodeId ? nodeById.get(singleSelectedNodeId) || null : null);
    const activeNodeToolNode = activeNodeTool ? nodeById.get(activeNodeTool.nodeId) || null : null;
    const infoNode = activeNodeTool?.kind === "info" ? activeNodeToolNode : null;
    const cropNode = activeNodeTool?.kind === "crop" ? activeNodeToolNode : null;
    const maskEditNode = activeNodeTool?.kind === "maskEdit" ? activeNodeToolNode : null;
    const outpaintNode = activeNodeTool?.kind === "outpaint" ? activeNodeToolNode : null;
    const mossLayoutNode = activeNodeTool?.kind === "mossLayout" ? activeNodeToolNode : null;
    const splitNode = activeNodeTool?.kind === "split" ? activeNodeToolNode : null;
    const angleNode = activeNodeTool?.kind === "angle" ? activeNodeToolNode : null;
    const contextMenuNode = contextMenu?.type === "node" ? nodeById.get(contextMenu.nodeId) || null : null;
    const previewNode = previewNodeId ? nodeById.get(previewNodeId) || null : null;
    const previewContent = previewNode?.metadata?.content;
    const hasMultipleSelectedNodes = selectedNodeIds.size > 1;
    const selectedNodes = useMemo(() => nodes.filter((node) => selectedNodeIds.has(node.id)), [nodes, selectedNodeIds]);
    const selectedVideoNodes = selectedNodes.filter((node) => node.type === CanvasNodeType.Video && Boolean(node.metadata?.content));
    const syncPlaySelectedVideos = () => {
        const ids = new Set(selectedVideoNodes.map((node) => node.id));
        const videos = Array.from(document.querySelectorAll<HTMLVideoElement>("video[data-canvas-video]")).filter((video) => ids.has(video.dataset.canvasVideo || ""));
        if (!videos.length) return;
        for (const video of videos) {
            video.muted = true;
            try {
                video.currentTime = 0;
            } catch {
                // Ignore videos whose metadata is not ready yet.
            }
        }
        requestAnimationFrame(() => {
            for (const video of videos) void video.play().catch(() => undefined);
        });
    };
    const canGroupSelection = canGroupSelectedNodes(selectedNodeIds, nodes);
    const canUngroupSelection = canUngroupSelectedNodes(selectedNodeIds, nodes);
    const activeNodeId = hasMultipleSelectedNodes ? null : hoveredNodeId || (selectedNodeIds.size === 1 ? Array.from(selectedNodeIds)[0] : null);
    const groupChildCountById = useMemo(() => {
        const map = new Map<string, number>();
        nodes.forEach((node) => {
            const groupId = node.metadata?.groupId;
            if (groupId) map.set(groupId, (map.get(groupId) || 0) + 1);
        });
        return map;
    }, [nodes]);
    const relatedHighlight = useMemo(() => {
        const nodeIds = new Set<string>();
        const connectionIds = new Set<string>();

        if (!activeNodeId) return { nodeIds, connectionIds };

        const addNode = (nodeId: string) => {
            nodeIds.add(nodeId);
            if (nodeById.get(nodeId)?.type === CanvasNodeType.Group) nodes.forEach((node) => node.metadata?.groupId === nodeId && nodeIds.add(node.id));
        };
        addNode(activeNodeId);
        connections.forEach((connection) => {
            if (connection.fromNodeId !== activeNodeId && connection.toNodeId !== activeNodeId) return;
            connectionIds.add(connection.id);
            addNode(connection.fromNodeId);
            addNode(connection.toNodeId);
        });

        return { nodeIds, connectionIds };
    }, [activeNodeId, connections, nodeById, nodes]);

    const mentionReferencesByNodeId = useMemo(() => {
        const map = new Map<string, ReturnType<typeof buildNodeMentionReferences>>();
        nodes.forEach((node) => map.set(node.id, buildNodeMentionReferences(node, nodes, connections)));
        return map;
    }, [connections, nodes]);
    const connectedNodesByNodeId = useMemo(() => {
        const map = new Map<string, CanvasNodeData[]>();
        connections.forEach((connection) => {
            const source = nodeById.get(connection.fromNodeId);
            if (!source) return;
            const connected = map.get(connection.toNodeId);
            if (connected) connected.push(source);
            else map.set(connection.toNodeId, [source]);
        });
        return map;
    }, [connections, nodeById]);
    const referenceConnectedNodeIds = useMemo(
        () =>
            new Set(
                [
                    referencePickerNodeId,
                    ...(referencePickerNodeId
                        ? connectedNodesByNodeId.get(referencePickerNodeId)?.flatMap((node) => (node.type === CanvasNodeType.Group ? [node.id, ...getGroupResourceNodes(node.id, nodes).map((child) => child.id)] : [node.id])) || []
                        : []),
                ].filter((id): id is string => Boolean(id)),
            ),
        [connectedNodesByNodeId, nodes, referencePickerNodeId],
    );
    const createNode = useCallback(
        (type: CanvasNodeTypeId, position?: Position, patch?: CanvasNodeMetadata): CanvasNodeData => {
            const targetPosition = position || getCanvasCenter();
            const newNode = createCanvasNode(type, targetPosition, patch);

            setNodes((prev) => [...prev, newNode]);
            setSelectedNodeIds(new Set([newNode.id]));
            setSelectedConnectionId(null);
            const definition = getNodeDefinition(type);
            // The panel opens unless the node is one whose content is its own editing surface: text is
            // edited in place, and audio has nothing to configure.
            const wantsPanel = definition?.autoOpenPanel ? true : isBuiltinNodeType(type) && type !== CanvasNodeType.Text && type !== CanvasNodeType.Audio && type !== CanvasNodeType.Group;
            if (wantsPanel) setDialogNodeId(newNode.id);
            return newNode;
        },
        [effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size, getCanvasCenter],
    );

    // The agent's hands are the same function the buttons press.

    /**
     * Drop every piece of UI state that points at these ids — the bookkeeping any deletion owes.
     *
     * A node can go without being the one the user deleted: a group is removed when the move that emptied it
     * is applied (`withoutEmptiedGroups`, #317). The card itself is gone from the list; a toolbar, a panel, a
     * menu or a selection still naming it would be the only thing left of it.
     */
    const forgetNodes = useCallback((ids: Set<string>) => {
        setSelectedNodeIds((current) => (current.size && [...current].some((id) => ids.has(id)) ? new Set([...current].filter((id) => !ids.has(id))) : current));
        setHoveredNodeId((current) => (current && ids.has(current) ? null : current));
        setToolbarNodeId((current) => (current && ids.has(current) ? null : current));
        setDialogNodeId((current) => (current && ids.has(current) ? null : current));
        setActiveNodeTool((current) => (current && ids.has(current.nodeId) ? null : current));
        setPreviewNodeId((current) => (current && ids.has(current) ? null : current));
        setRunningNodeId((current) => (current && ids.has(current) ? null : current));
        setReferencePickerNodeId((current) => (current && ids.has(current) ? null : current));
        setContextMenu((current) => (current?.type === "node" && ids.has(current.nodeId) ? null : current));
    }, []);

    const deleteNodes = useCallback(
        (ids: Set<string>): { removed: string[] } => {
            if (!ids.size) return { removed: [] };
            const before = nodesRef.current;
            // The cards that go, and the members of any group among them released where they stand.
            const kept = before.filter((node) => !ids.has(node.id)).map((node) => (node.metadata?.groupId && ids.has(node.metadata.groupId) ? { ...node, metadata: { ...node.metadata, groupId: undefined } } : node));
            // Deleting a card's last member empties it, and that shell is debris this press made (#318).
            const remaining = connectionsRef.current.filter((conn) => !ids.has(conn.fromNodeId) && !ids.has(conn.toNodeId));
            const settled = withoutEmptiedGroups(before, kept, remaining);
            setNodes(settled.nodes);
            setConnections(settled.connections);
            setSelectedNodeIds(new Set());
            setSelectedConnectionId(null);
            forgetNodes(new Set([...ids, ...settled.removed]));
            return { removed: settled.removed };
        },
        [forgetNodes, projectId],
    );

    /**
     * Put one node's top-left corner where a tool says, the way the end of a drag does.
     *
     * The snap a drag performs while the pointer moves is not repeated here — the tool states a corner,
     * so that corner is where the node goes. What is repeated is the part a drag leaves behind: a node that
     * moves on its own and whose centre now sits inside a group becomes a member of it, which is what makes
     * moving a node onto a group mean the same thing either way. A card carried by its own group keeps that
     * group, though — that is the move, not a regrouping (#316).
     */
    const moveNodesTo = useCallback((nodeId: string, position: Position): MoveOutcome | null => {
        const before = nodesRef.current;
        const named = before.find((node) => node.id === nodeId);
        if (!named) return null;
        const dx = position.x - named.position.x;
        const dy = position.y - named.position.y;
        // The cards this move carries: the named one, and a group's members — `withGroupMembers`, which is
        // also what the drag uses, so "move this group" means the same thing to a tool and to a hand.
        const carrying = withGroupMembers(new Set([nodeId]), before);
        const moved = before.map((node) => (carrying.has(node.id) ? { ...node, position: { x: node.position.x + dx, y: node.position.y + dy } } : node));
        // What a drag leaves behind, from the one function that decides it (`settleMoveMembership`): a card
        // that came with its group keeps it, and only a node that moved alone is placed by where it landed.
        // A card the move left with nothing in it is debris the move made, so it goes (#317).
        const settled = withoutEmptiedGroups(before, settleMoveMembership(moved, carrying), connectionsRef.current);
        setNodes(settled.nodes);
        setConnections(settled.connections);
        // The membership the landing changed, for the answer the tool gives: a member that travelled with its
        // card cannot appear here, so this is the node that moved on its own.
        const after = new Map(settled.nodes.map((node) => [node.id, node.metadata?.groupId]));
        const membership = before.filter((node) => node.metadata?.groupId !== after.get(node.id)).map((node) => ({ nodeId: node.id, from: node.metadata?.groupId, to: after.get(node.id) }));
        return { carried: [...carrying], membership, removed: settled.removed };
    }, []);

    /**
     * Wrap these nodes in one group — the Group button, for a set of ids rather than the live selection.
     *
     * One function for both callers: the toolbar names the current selection, a tool names the ids it was
     * given, and everything after that is the canvas's own grouping (`applyGroupSelection`). What it returns
     * is what a tool has to report back — which card was made, and what went into it.
     */
    const groupNodes = useCallback((ids: Set<string>): { groupId: string; memberIds: string[] } | null => {
        const members = collectGroupMemberNodes(ids, nodesRef.current);
        if (members.length < 2) return null;
        const rect = getGroupWrapRect(members);
        const created = createCanvasNode(CanvasNodeType.Group, { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
        const result = applyGroupSelection(ids, nodesRef.current, connectionsRef.current, { ...created, position: { x: rect.x, y: rect.y }, width: rect.width, height: rect.height });
        if (!result) return null;
        setNodes(result.nodes);
        setConnections(result.connections);
        setSelectedNodeIds(new Set(result.selectedIds));
        setSelectedConnectionId(null);
        setToolbarNodeId(result.selectedIds[0] || null);
        setDialogNodeId(null);
        setContextMenu(null);
        return { groupId: created.id, memberIds: members.map((member) => member.id) };
    }, []);

    const groupSelection = useCallback(() => {
        groupNodes(selectedNodeIdsRef.current);
    }, [groupNodes]);

    /**
     * Release these nodes from their groups, and say what that did.
     *
     * The button's own function: naming a group dissolves it, naming a member takes it out, and a group left
     * with no members goes away — all of it `applyUngroupSelection`. The two lists are only for the answer a
     * tool has to give; a press acts and says nothing.
     */
    const ungroupNodes = useCallback((ids: Set<string>): { released: string[]; dissolved: string[] } | null => {
        const before = nodesRef.current;
        const result = applyUngroupSelection(ids, before, connectionsRef.current);
        if (!result) return null;
        setNodes(result.nodes);
        setConnections(result.connections);
        setSelectedNodeIds(new Set(result.selectedIds));
        setSelectedConnectionId(null);
        setToolbarNodeId(result.selectedIds.length === 1 ? result.selectedIds[0] : null);
        setDialogNodeId(null);
        setContextMenu(null);
        const after = new Map(result.nodes.map((node) => [node.id, node]));
        const released = before.filter((node) => node.metadata?.groupId && after.get(node.id) && !after.get(node.id)?.metadata?.groupId).map((node) => node.id);
        const dissolved = before.filter((node) => ids.has(node.id) && node.type === CanvasNodeType.Group && !after.has(node.id)).map((node) => node.id);
        return { released, dissolved };
    }, []);

    const ungroupSelection = useCallback(
        (ids?: Set<string>) => {
            ungroupNodes(ids || selectedNodeIdsRef.current);
        },
        [ungroupNodes],
    );

    const deleteConnection = useCallback((connectionId: string) => {
        setConnections((prev) => prev.filter((conn) => conn.id !== connectionId));
        setSelectedConnectionId((current) => (current === connectionId ? null : current));
        setContextMenu((current) => (current?.type === "connection" && current.connectionId === connectionId ? null : current));
    }, []);

    const disconnectNodeReference = useCallback((fromNodeId: string, toNodeId: string) => {
        setConnections((prev) => prev.filter((connection) => connection.fromNodeId !== fromNodeId || connection.toNodeId !== toNodeId));
    }, []);

    const startNodeReferenceSelection = useCallback((nodeId: string) => {
        setReferencePickerNodeId(nodeId);
        setSelectedNodeIds(new Set([nodeId]));
        setSelectedConnectionId(null);
        setDialogNodeId(null);
    }, []);

    /** Let the user point at a node instead of typing its name. Resolves null when they change their mind. */
    const pickNodeForAgent = useCallback(
        () =>
            new Promise<string | null>((resolve) => {
                agentPickResolve.current = resolve;
                setPickingForAgent(true);
            }),
        [],
    );

    const finishAgentPick = useCallback((nodeId: string | null) => {
        setPickingForAgent(false);
        const resolve = agentPickResolve.current;
        agentPickResolve.current = null;
        resolve?.(nodeId);
    }, []);

    useEffect(() => {
        if (!pickingForAgent) return;
        const cancel = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopImmediatePropagation();
            finishAgentPick(null);
        };
        window.addEventListener("keydown", cancel, true);
        return () => window.removeEventListener("keydown", cancel, true);
    }, [finishAgentPick, pickingForAgent]);

    const exitNodeReferenceSelection = useCallback(() => {
        if (!referencePickerNodeId) return;
        setSelectedNodeIds(new Set([referencePickerNodeId]));
        setDialogNodeId(referencePickerNodeId);
        setReferencePickerNodeId(null);
    }, [referencePickerNodeId]);

    const selectNodeReference = useCallback(
        (fromNodeId: string) => {
            if (!referencePickerNodeId || referenceConnectedNodeIds.has(fromNodeId)) return;
            const source = nodesRef.current.find((node) => node.id === fromNodeId);
            if (!source || !isCanvasReferenceNode(source, nodesRef.current)) return;
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId, toNodeId: referencePickerNodeId }]);
        },
        [referenceConnectedNodeIds, referencePickerNodeId],
    );

    useEffect(() => {
        if (!referencePickerNodeId) return;
        const exit = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopImmediatePropagation();
            exitNodeReferenceSelection();
        };
        window.addEventListener("keydown", exit, true);
        return () => window.removeEventListener("keydown", exit, true);
    }, [exitNodeReferenceSelection, referencePickerNodeId]);

    const deselectCanvas = useCallback(() => {
        cancelPendingConnectionCreate();
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setContextMenu(null);
        setSelectionBox(null);
        setHoveredNodeId(null);
        setToolbarNodeId(null);
        setDialogNodeId(null);
    }, [cancelPendingConnectionCreate]);

    const clearCanvas = useCallback(() => {
        setNodes([]);
        setConnections([]);
        setActiveNodeTool(null);
        setPreviewNodeId(null);
        setRunningNodeId(null);
        deselectCanvas();
        setClearConfirmOpen(false);
    }, [deselectCanvas, projectId]);

    const duplicateNode = useCallback((nodeId: string) => {
        const source = nodesRef.current.find((node) => node.id === nodeId);
        if (!source) return;

        const id = `${source.type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const next: CanvasNodeData = {
            ...source,
            id,
            position: { x: source.position.x + 36, y: source.position.y + 36 },
        };
        const referenceConnections = connectionsRef.current.filter((connection) => connection.toNodeId === nodeId).map((connection) => ({ ...connection, id: nanoid(), toNodeId: id }));

        setNodes((prev) => [...prev, next]);
        setConnections((prev) => [...prev, ...referenceConnections]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        if (next.type !== CanvasNodeType.Group) setDialogNodeId(id);
    }, []);

    const copySelectedNodes = useCallback(() => {
        const selectedIds = selectedNodeIdsRef.current;
        if (!selectedIds.size) return;

        const copiedNodes = nodesRef.current
            .filter((node) => selectedIds.has(node.id))
            .map((node) => ({
                ...node,
                position: { ...node.position },
                metadata: node.metadata ? { ...node.metadata } : undefined,
            }));

        if (!copiedNodes.length) return;

        clipboardRef.current = {
            nodes: copiedNodes,
            connections: connectionsRef.current.filter((connection) => selectedIds.has(connection.toNodeId)).map((connection) => ({ ...connection })),
        };
    }, []);

    const pasteCopiedNodes = useCallback(() => {
        const clipboard = clipboardRef.current;
        if (!clipboard?.nodes.length) return false;

        const center = getCanvasCenter();
        const bounds = clipboard.nodes.reduce(
            (acc, node) => ({
                left: Math.min(acc.left, node.position.x),
                top: Math.min(acc.top, node.position.y),
                right: Math.max(acc.right, node.position.x + node.width),
                bottom: Math.max(acc.bottom, node.position.y + node.height),
            }),
            { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
        );
        const dx = center.x - (bounds.left + bounds.right) / 2;
        const dy = center.y - (bounds.top + bounds.bottom) / 2;
        const idMap = new Map<string, string>();
        const nextNodes = clipboard.nodes.map((node, index) => {
            const id = `${node.type}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
            idMap.set(node.id, id);
            return {
                ...node,
                id,
                position: {
                    x: node.position.x + dx,
                    y: node.position.y + dy,
                },
                metadata: node.metadata ? { ...node.metadata } : undefined,
            };
        });

        const pastedNodes = nextNodes.map((node) => {
            const groupId = node.metadata?.groupId;
            if (!groupId) return node;
            return { ...node, metadata: { ...node.metadata, groupId: idMap.get(groupId) } };
        });

        const nextConnections = clipboard.connections.flatMap((connection, index) => {
            const toNodeId = idMap.get(connection.toNodeId);
            if (!toNodeId) return [];
            return [
                {
                    ...connection,
                    id: `conn-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`,
                    fromNodeId: idMap.get(connection.fromNodeId) ?? connection.fromNodeId,
                    toNodeId,
                },
            ];
        });

        setNodes((prev) => [...prev, ...pastedNodes]);
        setConnections((prev) => [...prev, ...nextConnections]);
        setSelectedNodeIds(new Set(pastedNodes.map((node) => node.id)));
        setSelectedConnectionId(null);
        setContextMenu(null);
        setDialogNodeId(pastedNodes[0]?.type === CanvasNodeType.Group ? null : pastedNodes[0]?.id || null);
        return true;
    }, [getCanvasCenter]);

    const resetViewport = useCallback(() => {
        setViewport({ x: size.width / 2, y: size.height / 2, k: 1 });
        setContextMenu(null);
    }, [size.height, size.width]);

    const focusNode = useCallback(
        (nodeId: string) => {
            const node = nodesRef.current.find((item) => item.id === nodeId);
            if (!node) return;
            setHoverPreviewNodeId(null);
            const target = focusViewportForNode(node, size, measureFocusFrame(containerRef.current, nodeId));
            setSelectedNodeIds(new Set([nodeId]));
            setSelectedConnectionId(null);
            setContextMenu(null);

            if (focusAnimRef.current) cancelAnimationFrame(focusAnimRef.current);
            const start = { ...viewportRef.current };
            const duration = 450;
            const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
            let startTime: number | null = null;
            const step = (now: number) => {
                if (startTime === null) startTime = now;
                const progress = Math.min((now - startTime) / duration, 1);
                const t = easeOutCubic(progress);
                setViewport({ x: start.x + (target.x - start.x) * t, y: start.y + (target.y - start.y) * t, k: start.k + (target.k - start.k) * t });
                focusAnimRef.current = progress < 1 ? requestAnimationFrame(step) : null;
            };
            focusAnimRef.current = requestAnimationFrame(step);
        },
        [size.height, size.width],
    );

    const focusNodeRef = useRef(focusNode);
    useEffect(() => {
        focusNodeRef.current = focusNode;
    }, [focusNode]);

    const focusSelectedNode = useCallback(() => {
        const nodeId = selectedNodeIdsRef.current.values().next().value;
        if (nodeId) focusNode(nodeId);
    }, [focusNode]);

    useEffect(() => () => void (focusAnimRef.current && cancelAnimationFrame(focusAnimRef.current)), []);

    const setZoomScale = useCallback(
        (scale: number) => {
            const nextScale = Math.min(Math.max(scale, 0.05), 5);
            setViewport((prev) => ({
                x: size.width / 2 - ((size.width / 2 - prev.x) / prev.k) * nextScale,
                y: size.height / 2 - ((size.height / 2 - prev.y) / prev.k) * nextScale,
                k: nextScale,
            }));
            setContextMenu(null);
        },
        [size.height, size.width],
    );

    const applyHistory = useCallback((entry: CanvasHistoryEntry) => {
        if (historyCommitTimerRef.current) {
            clearTimeout(historyCommitTimerRef.current);
            historyCommitTimerRef.current = null;
        }
        applyingHistoryRef.current = true;
        setNodes(entry.nodes);
        setConnections(entry.connections);
        setBackgroundMode(entry.backgroundMode);
        setShowImageInfo(entry.showImageInfo);
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setContextMenu(null);
        setTimeout(() => {
            lastHistoryRef.current = entry;
            applyingHistoryRef.current = false;
            setHistoryState({ canUndo: historyRef.current.past.length > 0, canRedo: historyRef.current.future.length > 0 });
        });
    }, []);

    const undoCanvas = useCallback(() => {
        const previous = historyRef.current.past.pop();
        const current = lastHistoryRef.current;
        if (!previous || !current) return;
        historyRef.current.future.push(current);
        applyHistory(previous);
    }, [applyHistory]);

    const redoCanvas = useCallback(() => {
        const next = historyRef.current.future.pop();
        const current = lastHistoryRef.current;
        if (!next || !current) return;
        historyRef.current.past.push(current);
        applyHistory(next);
    }, [applyHistory]);

    const exportCurrentProject = useCallback(async () => {
        const project = useCanvasStore.getState().projects.find((item) => item.id === projectId);
        if (!project) return toast.error(t("canvas.runtime.notFound"));
        const hide = toast.loading(t("canvas.runtime.exporting"));
        try {
            await exportCanvas(project, project.title || t("canvas.title"));
            toast.success(t("canvas.runtime.exported"));
        } catch (error) {
            console.error(error);
            toast.error(t("canvas.sidePanel.exportFailed"));
        } finally {
            hide();
        }
    }, [projectId, t]);

    const handleCanvasMouseDown = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            setContextMenu(null);
            setNodeCreatePosition(null);
            setHoveredNodeId(null);
            setToolbarNodeId(null);
            setDialogNodeId(null);
            if (pendingConnectionCreateRef.current) cancelPendingConnectionCreate();
            if (event.button !== 0) return;

            const world = screenToCanvas(event.clientX, event.clientY);
            const nextSelectionBox = {
                startWorldX: world.x,
                startWorldY: world.y,
                currentWorldX: world.x,
                currentWorldY: world.y,
                additive: event.shiftKey,
                initialSelectedNodeIds: event.shiftKey ? Array.from(selectedNodeIdsRef.current) : [],
            };
            selectionBoxRef.current = nextSelectionBox;
            setSelectionBox(nextSelectionBox);
            if (!event.shiftKey) {
                setSelectedNodeIds(new Set());
            }

            setSelectedConnectionId(null);
        },
        [cancelPendingConnectionCreate, screenToCanvas],
    );

    // Selection-only logic shared by the bubbling drag entry point and outer capture handler.
    // Returns the single target ID after the click, or null for multi-selection or deselection, to sync the toolbar.
    const selectNodeByEvent = useCallback((event: Pick<ReactMouseEvent, "shiftKey" | "metaKey" | "ctrlKey">, nodeId: string) => {
        const nextSelected = new Set(selectedNodeIdsRef.current);
        if (event.shiftKey || event.metaKey || event.ctrlKey) {
            if (nextSelected.has(nodeId)) nextSelected.delete(nodeId);
            else nextSelected.add(nodeId);
        } else if (!nextSelected.has(nodeId)) {
            nextSelected.clear();
            nextSelected.add(nodeId);
        }
        setSelectedNodeIds(nextSelected);
        const soloId = nextSelected.size === 1 && nextSelected.has(nodeId) ? nodeId : null;
        setToolbarNodeId(soloId);
        return { nextSelected, soloId };
    }, []);

    // Capture-phase selection lets any inner element, including textarea or iframe, select the node and show its toolbar.
    // It only selects; body onMouseDown still starts dragging, so text selection inside editors does not drag the node.
    // Cache the capture result for the following bubbling drag handler to avoid applying shift-selection twice.
    const pendingSelectionRef = useRef<Set<string> | null>(null);
    const handleNodeSelectCapture = useCallback(
        (event: ReactMouseEvent, nodeId: string) => {
            if (event.button !== 0) return;
            setContextMenu(null);
            setHoveredNodeId(null);
            setSelectedConnectionId(null);
            const { nextSelected } = selectNodeByEvent(event, nodeId);
            pendingSelectionRef.current = nextSelected;
        },
        [selectNodeByEvent],
    );

    const handleNodeMouseDown = useCallback((event: ReactMouseEvent, nodeId: string) => {
        event.stopPropagation();
        // Capture already selected the node; this only starts dragging, with a fallback selection if capture did not run.
        const currentNodes = nodesRef.current;
        const nextSelected = pendingSelectionRef.current ?? selectNodeByEvent(event, nodeId).nextSelected;
        pendingSelectionRef.current = null;
        // A group dragged by its card carries its members, which is the same rule a tool's `move_node` reads
        // (`withGroupMembers`): the box and the nodes it is drawn around are one thing to move.
        const dragIds = withGroupMembers(nextSelected, currentNodes);
        const initialSelectedNodes = new Map(currentNodes.filter((node) => dragIds.has(node.id)).map((node): [string, { x: number; y: number }] => [node.id, { x: node.position.x, y: node.position.y }]));
        dragRef.current = {
            isDraggingNode: true,
            hasMoved: false,
            startX: event.clientX,
            startY: event.clientY,
            initialSelectedNodes,
            movedIds: new Set(initialSelectedNodes.keys()),
        };
        historyPausedRef.current = true;
        nodeDraggingRef.current = true;
        setIsNodeDragging(true);
    }, []);

    const finishNodeDrag = useCallback((clientX?: number, clientY?: number) => {
        if (rafRef.current) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }
        if (!dragRef.current.isDraggingNode) return;

        const wasClick = !dragRef.current.hasMoved && dragRef.current.initialSelectedNodes.size === 1;
        const clickedNodeId = dragRef.current.initialSelectedNodes.keys().next().value;
        const currentViewport = viewportRef.current;
        const dx = clientX == null ? 0 : (clientX - dragRef.current.startX) / currentViewport.k;
        const dy = clientY == null ? 0 : (clientY - dragRef.current.startY) / currentViewport.k;
        const initialPositions = dragRef.current.initialSelectedNodes;
        const movedIds = dragRef.current.movedIds;

        historyPausedRef.current = false;
        nodeDraggingRef.current = false;
        setIsNodeDragging(false);
        setDropTargetGroupId(null);
        if (dragRef.current.hasMoved && clientX != null && clientY != null) {
            const before = nodesRef.current;
            const moved = before.map((node) => {
                const initial = initialPositions.get(node.id);
                return initial ? { ...node, position: { x: initial.x + dx, y: initial.y + dy } } : node;
            });
            const targetGroup = findGroupDropTarget(movedIds, moved);
            // Dropping onto a card states the membership; anywhere else it is settled by where the cards
            // landed — the same rule the tool's move reads (`settleMoveMembership`, #316). Either way the card
            // this move emptied is debris it made, and goes (#317).
            const placed = targetGroup ? snapNodesIntoGroup(movedIds, moved, targetGroup) : settleMoveMembership(moved, movedIds);
            const settled = withoutEmptiedGroups(before, placed, connectionsRef.current);
            setNodes(settled.nodes);
            setConnections(settled.connections);
            if (settled.removed.length) forgetNodes(new Set(settled.removed));
        }

        dragRef.current.isDraggingNode = false;
        dragRef.current.hasMoved = false;
        dragRef.current.initialSelectedNodes = new Map();
        dragRef.current.movedIds = new Set();
        if (wasClick && clickedNodeId) {
            const clickedNode = nodesRef.current.find((node) => node.id === clickedNodeId);
            if (clickedNode?.type !== CanvasNodeType.Group) {
                setDialogNodeId(clickedNodeId);
                if (useConfigStore.getState().config.autoFocusOnSelect) {
                    // Wait for the generation panel to render so centering accounts for it.
                    requestAnimationFrame(() => focusNodeRef.current(clickedNodeId));
                }
            }
        }
    }, []);

    const handleGlobalMouseMove = useCallback(
        (event: MouseEvent) => {
            const currentViewport = viewportRef.current;

            if (dragRef.current.isDraggingNode) {
                const dx = (event.clientX - dragRef.current.startX) / currentViewport.k;
                const dy = (event.clientY - dragRef.current.startY) / currentViewport.k;
                const initialPositions = dragRef.current.initialSelectedNodes;
                const movedIds = dragRef.current.movedIds;
                if (Math.abs(event.clientX - dragRef.current.startX) > 3 || Math.abs(event.clientY - dragRef.current.startY) > 3) {
                    dragRef.current.hasMoved = true;
                }

                // Drop-target detection and node updates both run once per frame; mousemove can fire far more often than the display refreshes.
                if (rafRef.current) cancelAnimationFrame(rafRef.current);
                rafRef.current = requestAnimationFrame(() => {
                    const previewNodes = nodesRef.current.map((node) => {
                        const initial = initialPositions.get(node.id);
                        return initial ? { ...node, position: { x: initial.x + dx, y: initial.y + dy } } : node;
                    });
                    setDropTargetGroupId(findGroupDropTarget(movedIds, previewNodes)?.id || null);
                    setNodes((prev) =>
                        prev.map((node) => {
                            const initial = initialPositions.get(node.id);
                            return initial ? { ...node, position: { x: initial.x + dx, y: initial.y + dy } } : node;
                        }),
                    );
                    rafRef.current = null;
                });
                return;
            }

            if (connectingParamsRef.current && !pendingConnectionCreateRef.current) {
                const dropTarget = getConnectionDropTarget(event.clientX, event.clientY, connectingParamsRef.current);
                connectionTargetNodeIdRef.current = dropTarget.nodeId;
                setConnectionTargetNodeId(dropTarget.nodeId);
                setMouseWorld(screenToCanvas(event.clientX, event.clientY));
            }
        },
        [finishNodeDrag, getConnectionDropTarget, screenToCanvas],
    );

    const handleGlobalPointerMove = useCallback(
        (event: PointerEvent) => {
            const currentSelection = selectionBoxRef.current;
            if (!currentSelection) return;

            if (event.buttons === 0) {
                selectionBoxRef.current = null;
                setSelectionBox(null);
                return;
            }

            const world = screenToCanvas(event.clientX, event.clientY);
            const rectX = Math.min(currentSelection.startWorldX, world.x);
            const rectY = Math.min(currentSelection.startWorldY, world.y);
            const rectW = Math.abs(world.x - currentSelection.startWorldX);
            const rectH = Math.abs(world.y - currentSelection.startWorldY);
            const nextSelected = new Set<string>(currentSelection.additive ? currentSelection.initialSelectedNodeIds : []);

            nodesRef.current.forEach((node) => {
                const intersects = rectX < node.position.x + node.width && rectX + rectW > node.position.x && rectY < node.position.y + node.height && rectY + rectH > node.position.y;

                if (intersects) nextSelected.add(node.id);
            });

            const nextSelectionBox = { ...currentSelection, currentWorldX: world.x, currentWorldY: world.y };
            selectionBoxRef.current = nextSelectionBox;
            setSelectionBox(nextSelectionBox);
            setSelectedNodeIds(nextSelected);
        },
        [screenToCanvas],
    );

    const handleGlobalMouseUp = useCallback(
        (event: MouseEvent) => {
            finishNodeDrag(event.clientX, event.clientY);

            selectionBoxRef.current = null;
            setSelectionBox(null);

            if (pendingConnectionCreateRef.current) return;

            const currentConnection = connectingParamsRef.current;
            if (currentConnection) {
                const dropTarget = getConnectionDropTarget(event.clientX, event.clientY, currentConnection);
                if (dropTarget.nodeId) {
                    connectNodes(currentConnection, dropTarget.nodeId);
                    setConnecting(null);
                } else if (dropTarget.isNearNode) {
                    setConnecting(null);
                } else {
                    setMouseWorld(screenToCanvas(event.clientX, event.clientY));
                    setPendingConnectionCreate({ connection: currentConnection, position: screenToCanvas(event.clientX, event.clientY) });
                }
            }
        },
        [connectNodes, finishNodeDrag, getConnectionDropTarget, screenToCanvas, setConnecting],
    );

    useEffect(() => {
        const handlePointerUp = (event: PointerEvent) => finishNodeDrag(event.clientX, event.clientY);
        const cancelNodeDrag = () => finishNodeDrag();
        window.addEventListener("mousemove", handleGlobalMouseMove);
        window.addEventListener("mouseup", handleGlobalMouseUp);
        window.addEventListener("pointerup", handlePointerUp);
        window.addEventListener("pointercancel", cancelNodeDrag);
        window.addEventListener("blur", cancelNodeDrag);
        window.addEventListener("pointermove", handleGlobalPointerMove);
        return () => {
            window.removeEventListener("mousemove", handleGlobalMouseMove);
            window.removeEventListener("mouseup", handleGlobalMouseUp);
            window.removeEventListener("pointerup", handlePointerUp);
            window.removeEventListener("pointercancel", cancelNodeDrag);
            window.removeEventListener("blur", cancelNodeDrag);
            window.removeEventListener("pointermove", handleGlobalPointerMove);
        };
    }, [finishNodeDrag, handleGlobalMouseMove, handleGlobalMouseUp, handleGlobalPointerMove]);

    // Content ingress lives in its own module; this object is the entire surface it gets.
    const contentIngressDeps: ContentIngressDeps = useMemo(
        () => ({ setNodes, setSelectedNodeIds, setSelectedConnectionId, setDialogNodeId, setContextMenu, containerRef, size, screenToCanvas, getCanvasCenter }),
        [getCanvasCenter, screenToCanvas, setContextMenu, setDialogNodeId, setNodes, setSelectedConnectionId, setSelectedNodeIds, size],
    );
    const { imageInputRef, handleUploadRequest, handleImageInputChange, handleDrop, pasteSystemClipboard } = useContentIngress(contentIngressDeps);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || target?.closest("[contenteditable='true'],[data-canvas-no-zoom],[data-canvas-shortcuts-ignore]"))
                return;

            const key = event.key.toLowerCase();
            const isModifierShortcut = event.metaKey || event.ctrlKey;

            if (isModifierShortcut && key === "c" && window.getSelection()?.toString()) return;

            if (isModifierShortcut && !event.altKey && key === "z") {
                event.preventDefault();
                if (event.shiftKey) redoCanvas();
                else undoCanvas();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "y") {
                event.preventDefault();
                redoCanvas();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "a") {
                event.preventDefault();
                setSelectedNodeIds(new Set(nodesRef.current.map((node) => node.id)));
                setSelectedConnectionId(null);
                setContextMenu(null);
                setSelectionBox(null);
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "g") {
                if (event.shiftKey) {
                    if (canUngroupSelectedNodes(selectedNodeIdsRef.current, nodesRef.current)) {
                        event.preventDefault();
                        ungroupSelection();
                    }
                    return;
                }
                if (canGroupSelectedNodes(selectedNodeIdsRef.current, nodesRef.current)) {
                    event.preventDefault();
                    groupSelection();
                }
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "c") {
                event.preventDefault();
                copySelectedNodes();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "v") {
                event.preventDefault();
                if (!pasteCopiedNodes()) void pasteSystemClipboard();
                return;
            }

            if (event.key === "Delete" || event.key === "Backspace") {
                if (selectedNodeIdsRef.current.size) {
                    deleteNodes(new Set(selectedNodeIdsRef.current));
                } else if (selectedConnectionId) {
                    deleteConnection(selectedConnectionId);
                }
            }

            if (event.key === "Escape") {
                setSelectedNodeIds(new Set());
                setSelectedConnectionId(null);
                setContextMenu(null);
                setNodeCreatePosition(null);
                setSelectionBox(null);
                setConnecting(null);
                setHoveredNodeId(null);
                setToolbarNodeId(null);
                setDialogNodeId(null);
                setActiveNodeTool(null);
                setPendingConnectionCreate(null);
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [copySelectedNodes, deleteConnection, deleteNodes, groupSelection, pasteCopiedNodes, pasteSystemClipboard, redoCanvas, selectedConnectionId, setConnecting, undoCanvas, ungroupSelection]);

    const handleConnectStart = useCallback(
        (event: ReactMouseEvent, nodeId: string, handleType: "source" | "target") => {
            event.stopPropagation();
            setMouseWorld(screenToCanvas(event.clientX, event.clientY));
            setConnecting({ nodeId, handleType });
            connectionTargetNodeIdRef.current = null;
            setConnectionTargetNodeId(null);
            setSelectedConnectionId(null);
        },
        [screenToCanvas, setConnecting],
    );

    const handleNodeResize = useCallback((nodeId: string, width: number, height: number, position?: Position) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, width, height, position: position || node.position } : node)));
    }, []);

    const handleNodeResizeStart = useCallback(() => {
        setIsNodeResizing(true);
    }, []);
    const handleNodeResizeEnd = useCallback(() => setIsNodeResizing(false), []);

    const handleNodeContentChange = useCallback((nodeId: string, content: string) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, content } } : node)));
    }, []);

    const handleConfigNodeChange = useCallback((nodeId: string, patch: Partial<CanvasNodeData["metadata"]> = {}) => {
        setNodes((prev) =>
            prev.map((node) => {
                if (node.id !== nodeId) return node;
                const clearError = node.metadata?.status === NODE_STATUS_ERROR && patch.status === undefined ? { status: NODE_STATUS_IDLE, errorDetails: undefined } : {};
                return applyNodeConfigPatch(node, { ...patch, ...clearError });
            }),
        );
    }, []);

    const downloadNodeImage = useCallback((node: CanvasNodeData) => {
        if ((node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Video && node.type !== CanvasNodeType.Audio) || !node.metadata?.content) return;
        saveAs(node.metadata.content, `canvas-${node.type}-${node.id}.${node.type === CanvasNodeType.Video ? "mp4" : node.type === CanvasNodeType.Audio ? audioExtension(node.metadata.mimeType) : imageExtension(node.metadata.content)}`);
    }, []);

    const captureVideoNodeFrame = useCallback(
        async (nodeId: string, position: VideoFramePosition) => {
            setContextMenu(null);
            const node = nodesRef.current.find((item) => item.id === nodeId);
            const video = Array.from(containerRef.current!.querySelectorAll<HTMLVideoElement>("video[data-canvas-video]")).find((item) => item.dataset.canvasVideo === nodeId);
            if (node?.type !== CanvasNodeType.Video || !node.metadata?.content || !video) return toast.error(t("canvas.videoFrames.failed"));
            try {
                const image = await uploadImage(await captureVideoFrame(node.metadata.content, position, video.currentTime));
                const size = fitNodeSize(image.width, image.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                const id = nanoid();
                const x = node.position.x + node.width + 96;
                let y = node.position.y + node.height / 2 - size.height / 2;
                while (nodesRef.current.some((item) => item.id !== node.id && item.position.x < x + size.width && item.position.x + item.width > x && item.position.y < y + size.height && item.position.y + item.height > y)) y += size.height + 24;
                const child: CanvasNodeData = {
                    id,
                    type: CanvasNodeType.Image,
                    position: { x, y },
                    ...size,
                    metadata: imageMetadata(image),
                };
                setNodes((prev) => [...prev, child]);
                setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: id }]);
                setSelectedNodeIds(new Set([id]));
                setSelectedConnectionId(null);
                setDialogNodeId(id);
                toast.success(t("canvas.videoFrames.captured"));
            } catch {
                toast.error(t("canvas.videoFrames.failed"));
            }
        },
        [t],
    );

    // The node editors live in their own modules; this object is the entire surface they get.
    const nodeEditorDeps: NodeEditorDeps = useMemo(
        () => ({ setNodes, setConnections, setSelectedNodeIds, setSelectedConnectionId, setDialogNodeId, setRunningNodeId, closeNodeTool, startGenerationRequest, finishGenerationRequest }),
        [closeNodeTool, finishGenerationRequest, setConnections, setDialogNodeId, setNodes, setSelectedConnectionId, setSelectedNodeIds, setRunningNodeId, startGenerationRequest],
    );
    const { cropImageNode, splitImageNode, maskEditImageNode, outpaintImageNode, mossLayoutImageNode, upscaleImageNode, generateAngleNode } = useImageEditors(nodeEditorDeps);
    const { interpolateVideoNode } = useVideoEditors(nodeEditorDeps);

    const handleFontSizeChange = useCallback((nodeId: string, fontSize: number) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, fontSize } } : node)));
    }, []);

    // The tab tells you which canvas you are in. With no landing page, the browser tab is
    // the map — and multi-canvas work makes "which one is this?" a real question.
    // Restored on unmount so the list pages keep the plain app title.
    useEffect(() => {
        document.title = currentProject?.title ? `${currentProject.title} — ${t("meta.title")}` : t("meta.title");
        return () => {
            document.title = t("meta.title");
        };
    }, [currentProject?.title, t]);

    const preventCanvasContextMenu = useCallback((event: ReactMouseEvent) => {
        if ((event.target as HTMLElement).closest("[data-node-id]")) return;
        event.preventDefault();
        setContextMenu(null);
    }, []);

    // The four generation modes live in their own module; this object is the entire surface they get.
    const generationRunDeps: GenerationRunDeps = useMemo(
        () => ({
            setNodes,
            setSelectedNodeIds,
            setSelectedConnectionId,
            setDialogNodeId,
            nodesRef,
            connectionsRef,
            setRunningNodeId,
            pollVideoNodeTask,
            startGenerationRequest,
            finishGenerationRequest,
            completeVideoNodeTask,
        }),
        [completeVideoNodeTask, finishGenerationRequest, pollVideoNodeTask, setDialogNodeId, setNodes, setSelectedConnectionId, setSelectedNodeIds, startGenerationRequest],
    );
    const { runImageGeneration, runVideoGeneration, runAudioGeneration, pollAudioRun, pollImageRun } = useGenerationRuns(generationRunDeps);

    /**
     * Pick up the runs that were out when the page went away.
     *
     * One pass, once per opened canvas: a run belongs to the server, so the page has nothing to re-submit —
     * only to start watching again, with the poller for the kind of content it is. It used to be two effects
     * with two different gates (video resumed whatever its status said, audio and image only while they were
     * still `loading`), so one of the three could quietly not resume at all (#235).
     */
    const runResumeProjectRef = useRef<string | null>(null);
    useEffect(() => {
        if (!projectLoaded || runResumeProjectRef.current === projectId) return;
        runResumeProjectRef.current = projectId;
        for (const node of nodesRef.current.filter(hasResumableRun)) {
            if (node.type === CanvasNodeType.Video) void pollVideoNodeTask(node, true);
            else if (node.type === CanvasNodeType.Audio) void pollAudioRun(node, true);
            else void pollImageRun(node, true);
        }
        // Once per opened canvas: a re-render is not a reason to poll a run again.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [projectLoaded, projectId]);

    const handleGenerateNode = useCallback(
        async (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string, options?: GenerateOptions) => {
            const { askedBy, onStart } = options ?? {};
            /**
             * Whether a run went out, said once — the first word is the only one that matters.
             *
             * The tool's answer is built on this: "a run exists" is what tells the agent to expect a
             * message later rather than wait, and a refusal says why and that there is nothing to wait
             * for. Announcing it here rather than inside each mode is what keeps every early exit honest.
             */
            let announced = false;
            const start = (report: GenerateStart) => {
                if (announced) return;
                announced = true;
                onStart?.(report);
            };
            const sourceNode = nodesRef.current.find((node) => node.id === nodeId);
            // A wire that carries nothing is not a smaller request, it is a request this run cannot keep:
            // refuse and name the node rather than quietly generate something else (#230). The person who
            // pressed the button reads it in their language; the agent is answered with the full sentence.
            const emptyInputs = inputsHoldingNothing(nodeId, nodesRef.current, connectionsRef.current);
            if (emptyInputs.length) {
                toast.warning(t("canvas.runtime.connectionHoldsNothing", { name: emptyInputs.map((input) => input.node.id).join(", ") }));
                start({ started: false, reason: describeEmptyInputs(emptyInputs) });
                return;
            }
            const generationConfig = buildGenerationConfig(effectiveConfig, sourceNode, mode);
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openPreferences();
                start({ started: false, reason: `no model is set for ${mode} generation on this canvas, and the node's panel opened its settings` });
                return;
            }

            setRunningNodeId(nodeId);
            const runController = startGenerationRequest(nodeId, nodeId, nodeId);
            // The prompt is the prompt: regenerating asks the same question again, and refining the
            // picture means editing the question.
            const generationContext = await hydrateNodeGenerationContext(buildNodeGenerationContext(nodeId, nodesRef.current, connectionsRef.current, prompt));
            const effectivePrompt = generationContext.prompt.trim();
            if (generationContext.loras.length) generationConfig.params = { ...(generationConfig.params || {}), loras: generationContext.loras };
            if (runController.signal.aborted) {
                finishGenerationRequest(nodeId, runController);
                setRunningNodeId(null);
                start({ started: false, reason: "the generation was stopped before it started" });
                return;
            }
            const markSourceStatus = sourceNode?.type !== CanvasNodeType.Image;
            if (!effectivePrompt && mode === "audio") {
                finishGenerationRequest(nodeId, runController);
                setRunningNodeId(null);
                start({ started: false, reason: "the node has no prompt to generate from" });
                return;
            }
            const run: GenerationRun = {
                nodeId,
                prompt,
                sourceNode,
                effectivePrompt,
                generationConfig,
                generationContext,
                runController,
                askedBy,
                start,
            };
            if (markSourceStatus) setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, prompt, params: generationConfig.params, status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)));

            try {
                if (mode === "image") {
                    await runImageGeneration(run);
                    return;
                }

                if (mode === "video") {
                    await runVideoGeneration(run);
                    return;
                }

                await runAudioGeneration(run);
            } catch (error) {
                if (isGenerationCanceled(error)) {
                    start({ started: false, reason: "the generation was stopped before it started" });
                    return;
                }
                const errorDetails = error instanceof Error ? error.message : t("canvas.runtime.generationFailed");
                start({ started: false, reason: errorDetails });
                toast.error(errorDetails);
                setNodes((prev) =>
                    prev.map((node) =>
                        node.id === nodeId
                            ? !markSourceStatus
                                ? node
                                : {
                                      ...node,
                                      metadata: {
                                          ...node.metadata,
                                          status: NODE_STATUS_ERROR,
                                          errorDetails,
                                          ...(runWatchEnded(error) && node.type === CanvasNodeType.Video ? { runId: undefined } : {}),
                                      },
                                  }
                            : node,
                    ),
                );
            } finally {
                finishGenerationRequest(nodeId, runController);
                setRunningNodeId(null);
            }
        },
        [completeVideoNodeTask, effectiveConfig, finishGenerationRequest, isAiConfigReady, openPreferences, startGenerationRequest, t],
    );
    useEffect(() => {
        generateNodeRef.current = handleGenerateNode;
    }, [handleGenerateNode]);

    /**
     * Write a node's prompt the way its own panel writes it.
     *
     * Which field that is, is `promptFieldOf`'s answer — a node that holds a result keeps the words in
     * `composerContent` so typing cannot throw the result away, a config node has always used its composer,
     * and everything else keeps them in `prompt`. The panel and the agent's `set_prompt` ask the same
     * function, which is what stops the two from writing different fields for the same words (#229).
     */
    const setNodePrompt = useCallback(
        (nodeId: string, prompt: string) => {
            const node = nodesRef.current.find((candidate) => candidate.id === nodeId);
            if (!node) return;
            handleConfigNodeChange(nodeId, promptPatch(node, prompt));
        },
        [handleConfigNodeChange],
    );

    /**
     * What a node's next run would accept, for the agent's `set_node`.
     *
     * The keys come from the published contract of the *mode the run will use* — `imageModeFor` for a picture,
     * the node's own video mode for a film — which is the same list the panel's rows ask before they draw
     * themselves (#304). A sound's length bound is the model's own declaration, the one `clampAudioSeconds`
     * clamps to. Read from the node's current metadata, so the answer is about the node as it stands.
     */
    const nodeContract = useCallback(
        (nodeId: string, run?: { model?: string; mode?: string }) => {
            const node = nodesRef.current.find((candidate) => candidate.id === nodeId);
            if (!node) return {};
            const mode: CanvasNodeGenerationMode = node.type === CanvasNodeType.Video ? "video" : node.type === CanvasNodeType.Audio ? "audio" : "image";
            const config = buildGenerationConfig(effectiveConfig, node, mode);
            // The model a call is about to set, when it is setting one: the settings it states are judged by the
            // contract of the run they will be used by, which is the whole reason `set_node` is one tool.
            const model = run?.model || config.model;
            const contractMode = mode === "image" ? imageModeFor(config, model) : run?.mode || node.metadata?.videoMode || "";
            const contract = modelContractOf(effectiveConfig, model, contractMode);
            return {
                accepts: contract?.inputs,
                media: contract?.accepts,
                duration: channelModelOf(effectiveConfig, model)?.model.duration,
                // A film's pixels are derived from this tier and the shape, so `set_node` judges a stated size
                // against the tier the run will use — the node's own, or the canvas's default.
                tier: mode === "video" ? config.vquality : undefined,
            };
        },
        [effectiveConfig],
    );

    /**
     * The models a node may be set to, and the contract answer for each — the catalog `set_model` decides with.
     *
     * Built from `workflowModelOptions` for the node's kind, which is the pickers' own list, so the tool cannot
     * offer a model the panel would not; the names beside each value are the model's own and the workflow id,
     * because those are what `list_nodes` and `read_prompt` report and what a caller will therefore type.
     */
    const modelCatalog = useCallback(
        (capability: ModelCapability): ModelCatalog => {
            const options = workflowModelOptions(effectiveConfig, capability).flatMap((value) => {
                const model = channelModelOf(effectiveConfig, value)?.model;
                if (!model) return [];
                return [
                    {
                        value,
                        names: [...new Set([model.name, model.workflowId].filter((name): name is string => Boolean(name)))],
                        label: modelOptionLabel(effectiveConfig, value),
                        workflowId: model.workflowId || model.name,
                        mode: model.mode || "",
                        modes: model.variantModes || [],
                        modeMedia: Object.fromEntries(
                            (model.variantModes || []).flatMap((mode) => {
                                const media = mediaSummary(model.contracts?.[mode]?.accepts ?? model.accepts);
                                return media ? [[mode, media] as const] : [];
                            }),
                        ),
                        knobs: (model.parameters || []).map((parameter) => parameter.key),
                        blocked: model.blockedModes || [],
                        // A step is offered by the pickers (a node can be one) and is not what a prompt makes.
                        step: model.tool === true || model.hasPrompt === false,
                        takes: mediaSummary(model.accepts),
                    },
                ];
            });
            return { options, accepts: (value, mode, key) => acceptsInput(effectiveConfig, value, key, mode) };
        },
        [effectiveConfig],
    );

    /**
     * What a workflow takes as media, in three words, for the model listing.
     *
     * `1-4 images` and `words only` are the difference between a workflow that edits a picture and one that
     * draws from words, which is the first thing a caller wants to know after the name. A workflow that
     * declares nothing says nothing.
     */
    function mediaSummary(accepts: ModelAccepts | undefined) {
        if (!accepts) return "";
        const parts: string[] = [];
        for (const [kind, label] of [
            ["images", "image"],
            ["videos", "clip"],
            ["audios", "sound"],
        ] as const) {
            const range = accepts[kind];
            if (!range?.max) continue;
            parts.push(range.min === range.max ? `${range.min} ${label}` : `${range.min}-${range.max} ${label}s`);
        }
        return parts.length ? parts.join(" + ") : "words only";
    }

    // The agent's hands are the same functions the buttons press.
    useCanvasAgentTools({
        nodesRef,
        connectionsRef,
        createNode,
        generateNode: handleGenerateNode,
        setNodePrompt,
        writeText: handleNodeContentChange,
        connectNodes: addConnection,
        deleteNodes: (nodeIds) => deleteNodes(new Set(nodeIds)),
        focusNode,
        moveNode: moveNodesTo,
        resizeNode: handleNodeResize,
        groupNodes: (nodeIds) => groupNodes(new Set(nodeIds)),
        ungroupNodes: (nodeIds) => ungroupNodes(new Set(nodeIds)),
        stopNode: stopNodeRun,
        nodeContract,
        modelCatalog,
        writeMetadata: handleConfigNodeChange,
    });

    // Memoize every callback and render function passed to CanvasNode.
    // CanvasNode uses React.memo, but new prop references would invalidate it on every render and rerender every node
    // during click, hover, or viewport changes, which is especially expensive for Markdown. These useCallback values
    // and their memoized map/handler dependencies remain stable during interaction, so unchanged nodes do not rerender.

    const handleNodeHoverStart = useCallback((nodeId: string) => {
        if (nodeDraggingRef.current) return;
        setHoveredNodeId(nodeId);
    }, []);
    const handleVideoDimensions = useCallback((nodeId: string, width: number, height: number) => {
        if (!width || !height) return;
        setNodes((prev) =>
            prev.map((node) => {
                if (node.id !== nodeId || node.type !== CanvasNodeType.Video) return node;
                const next = fitNodeSize(width, height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                const sameSize = Math.abs(node.width - next.width) < 0.5 && Math.abs(node.height - next.height) < 0.5;
                const sameMeta = node.metadata?.naturalWidth === width && node.metadata?.naturalHeight === height;
                if (sameSize && sameMeta) return node;
                return {
                    ...node,
                    width: next.width,
                    height: next.height,
                    position: { x: node.position.x + node.width / 2 - next.width / 2, y: node.position.y + node.height / 2 - next.height / 2 },
                    metadata: { ...node.metadata, naturalWidth: width, naturalHeight: height },
                };
            }),
        );
    }, []);
    const handleNodeHoverEnd = useCallback((nodeId: string) => {
        setHoveredNodeId((current) => (current === nodeId ? null : current));
    }, []);
    const handleNodeViewImage = useCallback((node: CanvasNodeData) => {
        setPreviewNodeId(node.id);
    }, []);
    const handleSidebarHoverNode = useCallback((nodeId: string | null) => {
        setHoverPreviewNodeId(nodeId);
    }, []);
    const handleNodeContextMenu = useCallback((event: ReactMouseEvent, nodeId: string) => {
        event.preventDefault();
        event.stopPropagation();
        setSelectedNodeIds((current) => (current.has(nodeId) ? current : new Set([nodeId])));
        setSelectedConnectionId(null);
        setContextMenu({ type: "node", x: event.clientX, y: event.clientY, nodeId });
    }, []);

    const hasActiveGeneration = useCallback(
        (nodeId: string) => {
            if (runningNodeId === nodeId) return true;
            for (const request of generationRequestsRef.current.values()) {
                if (request.targetNodeId === nodeId || request.originNodeId === nodeId || request.runningNodeId === nodeId) return true;
            }
            return false;
        },
        [runningNodeId],
    );

    const renderNodePanel = useCallback(
        (panelNode: CanvasNodeData) =>
            panelNode.type === CanvasNodeType.Lora ? (
                <LoraNodePanel node={panelNode} theme={theme} onChange={(patch) => handleConfigNodeChange(panelNode.id, patch)} />
            ) : (
                <CanvasNodePromptPanel
                    node={panelNode}
                    nodes={nodes}
                    isRunning={hasActiveGeneration(panelNode.id)}
                    mentionReferences={mentionReferencesByNodeId.get(panelNode.id) || EMPTY_REFERENCES}
                    connectedNodes={connectedNodesByNodeId.get(panelNode.id) || []}
                    onConfigChange={handleConfigNodeChange}
                    onGenerate={handleGenerateNode}
                    onStop={confirmStopGeneration}
                    onDisconnectReference={disconnectNodeReference}
                    onStartReferenceSelection={startNodeReferenceSelection}
                    onOpenMaskEditor={(nodeId) => openNodeTool("maskEdit", nodeId)}
                    onOpenOutpaintEditor={(nodeId) => openNodeTool("outpaint", nodeId)}
                    onOpenMossLayoutEditor={(nodeId) => openNodeTool("mossLayout", nodeId)}
                    onImageSettingsOpenChange={(open) => {
                        setNodeImageSettingsOpen(open);
                        if (open) setToolbarNodeId(null);
                    }}
                />
            ),
        [confirmStopGeneration, connectedNodesByNodeId, disconnectNodeReference, handleConfigNodeChange, handleGenerateNode, hasActiveGeneration, mentionReferencesByNodeId, nodes, startNodeReferenceSelection],
    );

    const hoverPreviewNode = hoverPreviewNodeId ? nodeById.get(hoverPreviewNodeId) || null : null;
    const hoverPreviewMedia =
        hoverPreviewNode && (hoverPreviewNode.type === CanvasNodeType.Image || hoverPreviewNode.type === CanvasNodeType.Video) && hoverPreviewNode.metadata?.content
            ? {
                  video: hoverPreviewNode.type === CanvasNodeType.Video,
                  src: hoverPreviewNode.metadata.content,
                  width: hoverPreviewNode.metadata?.naturalWidth || hoverPreviewNode.width,
                  height: hoverPreviewNode.metadata?.naturalHeight || hoverPreviewNode.height,
              }
            : null;
    const showHoverPreview = Boolean(hoverPreviewMedia);
    const retainedPreviewRef = useRef<{ video: boolean; src: string; width: number; height: number } | null>(null);
    // Written during render on purpose: the overlay stays mounted while it fades out, so the last preview has to be
    // retained after the hovered node clears. Sizing reuses the measured container size instead of reading layout here.
    if (hoverPreviewMedia) {
        const previewSize = fitNodeSize(hoverPreviewMedia.width, hoverPreviewMedia.height, size.width * 0.9, size.height * 0.9);
        retainedPreviewRef.current = { video: hoverPreviewMedia.video, src: hoverPreviewMedia.src, width: previewSize.width, height: previewSize.height };
    }
    const retainedPreview = retainedPreviewRef.current;

    if (!projectLoaded) return <CanvasRefreshShell />;

    return (
        <main className="flex h-full min-h-0 overflow-hidden" style={{ background: theme.canvas.background, color: theme.node.text }}>
            <section className="relative min-w-0 flex-1 overflow-hidden">
                <CanvasSidePanel projectId={projectId} nodes={nodes} selectedNodeIds={selectedNodeIds} onFocusNode={focusNode} onPreviewNode={setPreviewNodeId} onHoverNode={handleSidebarHoverNode} />
                {agentOpen ? null : (
                    <button
                        type="button"
                        data-canvas-overlay=""
                        onClick={() => toggleAgent(projectId)}
                        aria-label={t("canvas.agent.title")}
                        className="absolute bottom-4 right-4 z-[95] grid size-12 place-items-center rounded-full border shadow-lg backdrop-blur transition hover:opacity-90"
                        style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                    >
                        <Bot className="size-5" />
                    </button>
                )}
                <CanvasAgentPanel canvasId={projectId} nodes={nodes} onFocusNode={focusNode} onPickNode={pickNodeForAgent} />
                <CanvasConflictDialog projectId={projectId} />
                <CanvasTopBar
                    title={currentProject?.title || t("canvas.runtime.untitledCanvas")}
                    menuItems={canvasMenuItems({
                        t,
                        canvasTool,
                        canUndo: historyState.canUndo,
                        canRedo: historyState.canRedo,
                        selectedCount: selectedNodeIds.size,
                        backgroundMode,
                        showImageInfo,
                        onCanvasToolChange: setCanvasTool,
                        onAddText: () => createNode(CanvasNodeType.Text),
                        onAddImage: () => createNode(CanvasNodeType.Image),
                        onAddVideo: () => createNode(CanvasNodeType.Video),
                        onAddGroup: () => createNode(CanvasNodeType.Group),
                        onAddLora: () => createNode(CanvasNodeType.Lora),
                        onUpload: () => handleUploadRequest(),
                        onUndo: undoCanvas,
                        onRedo: redoCanvas,
                        onFocusSelected: focusSelectedNode,
                        onDeleteSelected: () => deleteNodes(new Set(selectedNodeIds)),
                        onBackgroundModeChange: setBackgroundMode,
                        onShowImageInfoChange: setShowImageInfo,
                        onExport: () => void exportCurrentProject(),
                        onClear: () => setClearConfirmOpen(true),
                    })}
                />

                <InfiniteCanvas
                    containerRef={containerRef}
                    viewport={viewport}
                    tool={canvasTool}
                    backgroundMode={backgroundMode}
                    onViewportChange={(next) => {
                        setViewport(next);
                        setContextMenu(null);
                    }}
                    onCanvasMouseDown={(event) => {
                        if (!referencePickerNodeId) handleCanvasMouseDown(event);
                    }}
                    onCanvasDeselect={referencePickerNodeId ? undefined : deselectCanvas}
                    onCanvasDoubleClick={(event) => {
                        if (referencePickerNodeId) return;
                        setContextMenu(null);
                        setNodeCreatePosition(screenToCanvas(event.clientX, event.clientY));
                    }}
                    onContextMenu={preventCanvasContextMenu}
                    onDrop={handleDrop}
                >
                    <svg className="absolute left-0 top-0 h-[10000px] w-[10000px] overflow-visible" style={{ pointerEvents: "none", transform: "translateZ(0)", zIndex: 0 }}>
                        {visibleConnections.map(({ connection, from, to }) => (
                            <ConnectionPath
                                key={connection.id}
                                connection={connection}
                                from={from}
                                to={to}
                                active={selectedConnectionId === connection.id || relatedHighlight.connectionIds.has(connection.id)}
                                onSelect={() => {
                                    setSelectedConnectionId(connection.id);
                                    setSelectedNodeIds(new Set());
                                    setContextMenu(null);
                                }}
                                onContextMenu={(event) => {
                                    setSelectedConnectionId(connection.id);
                                    setSelectedNodeIds(new Set());
                                    setContextMenu({ type: "connection", x: event.clientX, y: event.clientY, connectionId: connection.id });
                                }}
                            />
                        ))}
                        {connectingParams ? <ActiveConnectionPath node={nodeById.get(connectingParams.nodeId)} handle={connectingParams} mouseWorld={mouseWorld} target={connectionTargetNodeId ? nodeById.get(connectionTargetNodeId) : undefined} /> : null}
                    </svg>

                    {visibleNodes.map((node) => (
                        <CanvasNode
                            key={node.id}
                            data={node}
                            scale={viewport.k}
                            isSelected={selectedNodeIds.has(node.id)}
                            isRelated={relatedHighlight.nodeIds.has(node.id)}
                            isFocusRelated={activeNodeId === node.id}
                            isConnectionTarget={connectionTargetNodeId === node.id}
                            isConnecting={Boolean(connectingParams)}
                            referenceSelectionState={
                                pickingForAgent
                                    ? node.type === CanvasNodeType.Group
                                        ? "disabled"
                                        : "available"
                                    : !referencePickerNodeId
                                      ? undefined
                                      : node.id === referencePickerNodeId
                                        ? "target"
                                        : referenceConnectedNodeIds.has(node.id) || !isCanvasReferenceNode(node, nodes)
                                          ? "disabled"
                                          : "available"
                            }
                            // A card that holds words has no panel: its words are edited on the card itself, and
                            // nothing asks it anything (#278). Everything else under the pointer opens one.
                            showPanel={!isNodeResizing && dialogNodeId === node.id && !selectionBox && node.type !== CanvasNodeType.Text}
                            groupChildCount={groupChildCountById.get(node.id) || 0}
                            isGroupDropTarget={dropTargetGroupId === node.id}
                            showImageInfo={showImageInfo}
                            mentionReferences={mentionReferencesByNodeId.get(node.id) || EMPTY_REFERENCES}
                            renderPanel={renderNodePanel}
                            onMouseDown={handleNodeMouseDown}
                            onSelectCapture={handleNodeSelectCapture}
                            onHoverStart={handleNodeHoverStart}
                            onHoverEnd={handleNodeHoverEnd}
                            onConnectStart={handleConnectStart}
                            onResizeStart={handleNodeResizeStart}
                            onResize={handleNodeResize}
                            onResizeEnd={handleNodeResizeEnd}
                            onContentChange={handleNodeContentChange}
                            onVideoDimensions={handleVideoDimensions}
                            onViewImage={handleNodeViewImage}
                            onSelectReference={pickingForAgent ? finishAgentPick : selectNodeReference}
                            onContextMenu={handleNodeContextMenu}
                        />
                    ))}

                    {selectionBox ? (
                        <svg
                            className="pointer-events-none absolute z-[100] overflow-visible"
                            style={{
                                left: Math.min(selectionBox.startWorldX, selectionBox.currentWorldX),
                                top: Math.min(selectionBox.startWorldY, selectionBox.currentWorldY),
                                width: Math.abs(selectionBox.currentWorldX - selectionBox.startWorldX),
                                height: Math.abs(selectionBox.currentWorldY - selectionBox.startWorldY),
                            }}
                        >
                            <rect width="100%" height="100%" fill={theme.canvas.selectionFill} stroke={theme.canvas.selectionStroke} strokeOpacity={0.55} strokeWidth={1 / viewport.k} strokeDasharray={`${6 / viewport.k} ${4 / viewport.k}`} />
                        </svg>
                    ) : null}
                    {pendingConnectionCreate ? <ConnectionCreateMenu pending={pendingConnectionCreate} scale={viewport.k} onCreate={(type) => createConnectedNode(type, pendingConnectionCreate)} onClose={cancelPendingConnectionCreate} /> : null}
                    {nodeCreatePosition ? (
                        <NodeCreateMenu
                            position={nodeCreatePosition}
                            scale={viewport.k}
                            onCreate={(type) => {
                                createNode(type, nodeCreatePosition);
                                setNodeCreatePosition(null);
                            }}
                            onClose={() => setNodeCreatePosition(null)}
                        />
                    ) : null}
                </InfiniteCanvas>

                {pickingForAgent ? (
                    <button
                        type="button"
                        className="absolute left-1/2 top-4 z-[90] -translate-x-1/2 rounded-full border px-4 py-2 text-sm font-medium shadow-lg backdrop-blur"
                        style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }}
                        onClick={() => finishAgentPick(null)}
                    >
                        {t("canvas.agent.pickingNode")}
                    </button>
                ) : null}

                {referencePickerNodeId ? (
                    <button
                        type="button"
                        className="absolute left-1/2 top-4 z-[90] -translate-x-1/2 rounded-full border px-4 py-2 text-sm font-medium shadow-lg backdrop-blur"
                        style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }}
                        onClick={exitNodeReferenceSelection}
                    >
                        {t("canvas.references.selectingHint")}
                    </button>
                ) : null}

                <div
                    className="pointer-events-none absolute inset-0 z-[80] flex items-center justify-center transition-opacity duration-200 ease-out"
                    style={{ background: `color-mix(in srgb, ${theme.canvas.background} 76%, transparent)`, opacity: showHoverPreview ? 1 : 0 }}
                >
                    <div
                        className="flex flex-col overflow-hidden rounded-2xl border transition-transform duration-200 ease-out"
                        style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, boxShadow: "0 24px 60px rgba(0,0,0,.32)", transform: showHoverPreview ? "scale(1)" : "scale(0.95)" }}
                    >
                        {retainedPreview ? (
                            <>
                                <div className="max-w-full truncate px-3.5 py-2 text-sm font-medium" style={{ color: theme.node.text }}>
                                    {t(retainedPreview.video ? "canvas.nodeTypes.video" : "canvas.nodeTypes.image")}
                                </div>
                                <div className="overflow-hidden" style={{ width: retainedPreview.width, height: retainedPreview.height }}>
                                    {retainedPreview.video ? <video src={retainedPreview.src} muted playsInline preload="metadata" className="size-full object-contain" /> : <img src={retainedPreview.src} alt="" className="size-full object-contain" />}
                                </div>
                            </>
                        ) : null}
                    </div>
                </div>

                <CanvasNodeHoverToolbar
                    node={isNodeDragging || isNodeResizing || nodeImageSettingsOpen || Boolean(referencePickerNodeId) ? null : toolbarNode}
                    viewport={viewport}
                    onKeep={keepNodeToolbar}
                    onLeave={hideNodeToolbar}
                    onInfo={(node) => openNodeTool("info", node.id)}
                    onDecreaseFont={(node) => handleFontSizeChange(node.id, Math.max(10, (node.metadata?.fontSize || 14) - 2))}
                    onIncreaseFont={(node) => handleFontSizeChange(node.id, Math.min(32, (node.metadata?.fontSize || 14) + 2))}
                    onInterpolateVideo={(node) => void interpolateVideoNode(node)}
                    onDownload={downloadNodeImage}
                    onMaskEdit={(node) => openNodeTool("maskEdit", node.id)}
                    onCrop={(node) => openNodeTool("crop", node.id)}
                    onSplit={(node) => openNodeTool("split", node.id)}
                    onUpscale={(node) => upscaleImageNode(node)}
                    onAngle={(node) => openNodeTool("angle", node.id)}
                    onViewImage={handleNodeViewImage}
                    onDelete={(node) => deleteNodes(new Set([node.id]))}
                    onUngroup={(node) => ungroupSelection(new Set([node.id]))}
                />

                {hasMultipleSelectedNodes && !selectionBox ? (
                    <CanvasSelectionToolbar
                        nodes={selectedNodes}
                        viewport={viewport}
                        showToolbar={!isNodeDragging && !isNodeResizing}
                        canGroup={canGroupSelection}
                        canUngroup={canUngroupSelection}
                        canSyncPlay={selectedVideoNodes.length >= 2}
                        onGroup={groupSelection}
                        onUngroup={ungroupSelection}
                        onSyncPlay={syncPlaySelectedVideos}
                    />
                ) : null}

                {isMiniMapOpen ? <Minimap nodes={nodes} viewport={viewport} viewportSize={size} onViewportChange={setViewport} /> : null}

                <CanvasZoomControls scale={viewport.k} onScaleChange={setZoomScale} onReset={resetViewport} isMiniMapOpen={isMiniMapOpen} onToggleMiniMap={() => setIsMiniMapOpen((value) => !value)} />

                {contextMenu ? (
                    <CanvasNodeContextMenu
                        menu={contextMenu}
                        canCaptureVideoFrame={contextMenuNode?.type === CanvasNodeType.Video && Boolean(contextMenuNode.metadata?.content)}
                        canGroup={contextMenu.type === "node" && canGroupSelection}
                        canUngroup={contextMenu.type === "node" && canUngroupSelection}
                        onClose={() => setContextMenu(null)}
                        onCaptureVideoFrame={(position) => {
                            if (contextMenu.type !== "node") return;
                            void captureVideoNodeFrame(contextMenu.nodeId, position);
                        }}
                        onDuplicate={() => {
                            if (contextMenu.type !== "node") return;
                            duplicateNode(contextMenu.nodeId);
                            setContextMenu(null);
                        }}
                        onGroup={groupSelection}
                        onUngroup={ungroupSelection}
                        onDelete={() => {
                            if (contextMenu.type === "node") {
                                deleteNodes(new Set([contextMenu.nodeId]));
                            } else {
                                deleteConnection(contextMenu.connectionId);
                            }
                            setContextMenu(null);
                        }}
                    />
                ) : null}

                <input ref={imageInputRef} type="file" multiple accept="image/*,video/*,audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav" className="hidden" onChange={handleImageInputChange} />

                <CanvasNodeInfoModal node={infoNode} open={Boolean(infoNode)} onClose={() => closeNodeTool()} />

                {cropNode?.metadata?.content ? <CanvasNodeCropDialog dataUrl={cropNode.metadata.content} open={Boolean(cropNode)} onClose={() => closeNodeTool()} onConfirm={(crop) => void cropImageNode(cropNode!, crop)} /> : null}

                {maskEditNode?.metadata?.content ? (
                    <CanvasNodeMaskEditDialog dataUrl={maskEditNode.metadata.content} open={Boolean(maskEditNode)} onClose={() => closeNodeTool()} onConfirm={(payload) => void maskEditImageNode(maskEditNode!, payload)} />
                ) : null}

                {outpaintNode?.metadata?.content ? (
                    <CanvasNodeOutpaintDialog
                        dataUrl={outpaintNode.metadata.content}
                        open={Boolean(outpaintNode)}
                        promptDefault={outpaintNode.metadata.composerContent ?? outpaintNode.metadata.prompt ?? ""}
                        onClose={() => closeNodeTool()}
                        onConfirm={(payload) => void outpaintImageNode(outpaintNode!, payload)}
                    />
                ) : null}

                {mossLayoutNode ? (
                    <CanvasNodeMossLayoutDialog
                        open={Boolean(mossLayoutNode)}
                        dataUrl={mossLayoutNode.metadata?.content}
                        promptDefault={mossLayoutNode.metadata?.composerContent ?? mossLayoutNode.metadata?.prompt ?? ""}
                        size={mossLayoutNode.metadata?.size}
                        modelLabel="MOSS-Image"
                        layout={mossLayoutNode.metadata?.layout}
                        onClose={() => closeNodeTool()}
                        onConfirm={(payload) => void mossLayoutImageNode(mossLayoutNode, payload)}
                    />
                ) : null}

                {splitNode?.metadata?.content ? <CanvasNodeSplitDialog dataUrl={splitNode.metadata.content} open={Boolean(splitNode)} onClose={() => closeNodeTool()} onConfirm={(params) => void splitImageNode(splitNode!, params)} /> : null}

                {angleNode?.metadata?.content ? (
                    <Suspense fallback={null}>
                        <CanvasNodeAngleDialog dataUrl={angleNode.metadata.content} open={Boolean(angleNode)} onClose={() => closeNodeTool()} onConfirm={(params) => void generateAngleNode(angleNode!, params)} />
                    </Suspense>
                ) : null}

                <Dialog
                    title={t("canvas.runtime.imageDetails")}
                    open={Boolean(previewContent)}
                    onClose={() => setPreviewNodeId(null)}
                    size="auto"
                    bodyClassName="p-0"
                    bodyStyle={{ display: "flex", justifyContent: "center", alignItems: "center", maxHeight: "80vh" }}
                >
                    {previewContent ? <img src={previewContent} alt="" style={{ maxWidth: "100%", maxHeight: "80vh", objectFit: "contain" }} /> : null}
                </Dialog>

                <Dialog
                    title={t("canvas.runtime.clearTitle")}
                    open={clearConfirmOpen}
                    onClose={() => setClearConfirmOpen(false)}
                    footer={
                        <>
                            <Button onClick={() => setClearConfirmOpen(false)}>{t("common.cancel")}</Button>
                            <Button danger type="primary" onClick={clearCanvas}>
                                {t("canvas.runtime.clear")}
                            </Button>
                        </>
                    }
                    size="form"
                >
                    <p className="text-sm opacity-60">{t("canvas.runtime.clearDescription")}</p>
                </Dialog>
            </section>
        </main>
    );
}
