import { ArrowUp, LoaderCircle, Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/kit/button";
import { Tooltip } from "@/components/kit/tooltip";
import { WorkflowModelPicker } from "@/components/model-picker";
import { videoModelModePatch } from "@/lib/canvas/video-model-mode";
import { CanvasNodeReferenceBar } from "./canvas-node-reference-bar";
import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import { channelModelOf, modelContractOf, type AiConfig, type ModelAccepts, type ModelParameter } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasGenerationMode, type CanvasNodeData } from "@/types/canvas";

/**
 * The panel of a node that *runs a step* rather than answering a prompt.
 *
 * An interpolation, an upscaler and an angle re-render take a clip or a picture and a knob, and have
 * nothing to be asked in words. Their node is still an ordinary node — the canvas submits the same run —
 * so this panel is the same panel with the parts the workflow does not have left out, and the parts it
 * declares (`accepts`, `parameters`) rendered from that declaration instead of from a list of names.
 *
 * What it shows is the workflow's own contract, which is also what validates the run: if a node says it
 * needs one clip, the server will say the same thing, with the same numbers.
 */
export function CanvasToolNodePanel({
    node,
    nodes,
    config,
    connectedNodes,
    isRunning,
    onConfigChange,
    onGenerate,
    onStop,
    onDisconnectReference,
    onStartReferenceSelection,
    prompt,
}: {
    node: CanvasNodeData;
    nodes: CanvasNodeData[];
    config: AiConfig;
    connectedNodes: CanvasNodeData[];
    isRunning: boolean;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => void;
    onGenerate: (nodeId: string, mode: CanvasGenerationMode, prompt: string) => void;
    onStop: (nodeId: string) => void;
    onDisconnectReference?: (fromNodeId: string, toNodeId: string) => void;
    onStartReferenceSelection?: (nodeId: string) => void;
    /**
     * The node's prompt, when this step takes words at all — an angle re-render is told what to do with the
     * picture, an interpolation has nothing to be asked. The words live in the composer's own state, so it
     * hands them in rather than this panel keeping a second copy of them.
     */
    prompt?: { value: string; onChange: (value: string) => void; onCommit: () => void; placeholder: string };
}) {
    const { t } = useTranslation();
    const theme = useCanvasTheme();
    const mode: CanvasGenerationMode = node.type === CanvasNodeType.Video ? "video" : node.type === CanvasNodeType.Audio ? "audio" : "image";
    const model = channelModelOf(config, config.model)?.model;
    const accepts = modelContractOf(config, config.model)?.accepts;
    const counts = { image: countOf(connectedNodes, CanvasNodeType.Image), video: countOf(connectedNodes, CanvasNodeType.Video), audio: countOf(connectedNodes, CanvasNodeType.Audio) };
    const requirements = requirementsOf(accepts, counts);
    const total = counts.image + counts.video + counts.audio;
    const minTotal = accepts?.minTotal || 0;
    const ready = requirements.every((item) => item.have >= item.min && (!item.max || item.have <= item.max)) && (!minTotal || total >= minTotal);
    const showTotal = minTotal > requirements.reduce((sum, item) => sum + item.min, 0);
    const parameters = model?.parameters || [];
    const params = node.metadata?.params || {};

    const setParam = (key: string, value: unknown) => onConfigChange(node.id, { params: { ...params, [key]: value } });

    return (
        <div
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
                addDisabled={requirements.every((item) => Boolean(item.max) && item.have >= item.max)}
                addDisabledHint={t("canvas.toolPanel.full")}
            />
            {prompt ? (
                <textarea
                    className="thin-scrollbar mb-2 min-h-16 w-full resize-none rounded-xl border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                    style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                    placeholder={prompt.placeholder}
                    value={prompt.value}
                    onChange={(event) => prompt.onChange(event.target.value)}
                    onBlur={() => prompt.onCommit()}
                />
            ) : null}
            <div className="mb-2 flex min-w-0 items-center gap-2">
                {/* The node can be retargeted: another step, or a workflow that does take a prompt — the panel
                    becomes that workflow's on the next render, because it is built from the contract. */}
                <WorkflowModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, modelPatch(config, mode, model))} capability={mode} className="max-w-[190px]" />
            </div>
            <div className="space-y-1 px-1 text-sm leading-5">
                {requirements.length || showTotal ? (
                    <>
                        {requirements.map((item) => (
                            <div key={item.kind} className="flex items-center gap-2">
                                <span className={item.have >= item.min ? "" : "text-[#ef4444]"}>{t("canvas.toolPanel.needs", { count: item.min, kind: t(`canvas.toolPanel.kinds.${item.kind}`), have: item.have })}</span>
                            </div>
                        ))}
                        {showTotal ? <div className={total >= minTotal ? "" : "text-[#ef4444]"}>{t("canvas.toolPanel.needsAny", { count: minTotal, have: total })}</div> : null}
                    </>
                ) : (
                    <span>{t("canvas.toolPanel.noMedia")}</span>
                )}
            </div>
            {parameters.length ? (
                <div className="mt-3 flex flex-wrap items-center gap-2 px-1">
                    <Settings2 className="size-3.5 shrink-0 opacity-50" />
                    {parameters.map((parameter) => (
                        <ParameterControl key={parameter.key} parameter={parameter} value={params[parameter.key]} onChange={(value) => setParam(parameter.key, value)} theme={theme} />
                    ))}
                </div>
            ) : null}
            <div className="mt-3 flex items-center justify-end">
                <Tooltip title={ready ? t("canvas.promptPanel.generate") : t("canvas.toolPanel.blocked")}>
                    <Button
                        type="primary"
                        className={`!h-10 shrink-0 !rounded-full ${isRunning ? "!min-w-10 !px-2" : "!min-w-16 !px-3"}`}
                        danger={isRunning}
                        disabled={!isRunning && !ready}
                        onClick={() => {
                            if (isRunning) return onStop(node.id);
                            // A step that takes words sends the box; one that does not sends the node's own
                            // words unchanged, so the run never claims a prompt the user did not write.
                            onGenerate(node.id, mode, prompt ? prompt.value : node.metadata?.prompt || "");
                        }}
                        aria-label={t(isRunning ? "canvas.promptPanel.stop" : "canvas.promptPanel.generate")}
                    >
                        <span className="flex items-center gap-1.5">{isRunning ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}</span>
                    </Button>
                </Tooltip>
            </div>
        </div>
    );
}

function countOf(nodes: CanvasNodeData[], type: CanvasNodeType) {
    return nodes.filter((node) => node.type === type).length;
}

/**
 * What picking another model changes.
 *
 * A video workflow carries a mode of its own, so the selection and the mode are written together — the
 * same patch the composer applies, so switching between a step and a from-prompt workflow cannot leave
 * half of the previous answer behind.
 */
function modelPatch(config: AiConfig, mode: CanvasGenerationMode, model: string): Partial<NonNullable<CanvasNodeData["metadata"]>> {
    return mode === "video" ? videoModelModePatch(config, model) : { model };
}

type Requirement = { kind: "image" | "video" | "audio"; min: number; max: number; have: number };

/**
 * What the node still needs, in the workflow's own numbers.
 *
 * A kind the workflow does not declare is unconstrained, which is why only declared kinds appear here: an
 * undeclared kind is not "zero allowed", it is a kind the graph never mentions (media.go).
 */
function requirementsOf(accepts: ModelAccepts | undefined, counts: { image: number; video: number; audio: number }): Requirement[] {
    if (!accepts) return [];
    const items: Requirement[] = [];
    const add = (kind: Requirement["kind"], limit: { min: number; max: number } | undefined, have: number) => {
        if (!limit) return;
        if (!limit.min && !limit.max) return;
        items.push({ kind, min: limit.min, max: limit.max, have });
    };
    add("image", accepts.images, counts.image);
    add("video", accepts.videos, counts.video);
    add("audio", accepts.audios, counts.audio);
    return items;
}

/**
 * One declared knob, rendered from its own declaration.
 *
 * The label is the workflow's (`Multiplier`, `Upscale model`) and is shown instead of guessed at, because
 * nothing here knows what the number means: a pill reading "2" beside "Multiplier" says it, and a control
 * that appended its own unit would be inventing one.
 */
function ParameterControl({ parameter, value, onChange, theme }: { parameter: ModelParameter; value: unknown; onChange: (value: unknown) => void; theme: ReturnType<typeof useCanvasTheme> }) {
    const current = value ?? parameter.default;
    const label = parameter.label || parameter.key;
    const options = parameter.options || [];
    if (options.length) {
        return (
            <span className="flex min-w-0 items-center gap-1.5">
                <span className="text-xs opacity-55">{label}</span>
                <select className="h-8 max-w-[200px] rounded-full border bg-transparent px-2 text-sm" style={{ borderColor: theme.node.stroke, color: theme.node.text }} value={String(current ?? "")} onChange={(event) => onChange(event.target.value)}>
                    {options.map((option) => (
                        <option key={option} value={option}>
                            {option}
                        </option>
                    ))}
                </select>
            </span>
        );
    }
    const min = parameter.min ?? 1;
    const max = parameter.max ?? min;
    const step = parameter.step || 1;
    const values: number[] = [];
    for (let next = min; next <= max && values.length < 8; next += step) values.push(next);
    if (values.length > 1) {
        return (
            <span className="flex items-center gap-1.5">
                <span className="text-xs opacity-55">{label}</span>
                {values.map((option) => {
                    const selected = Number(current) === option;
                    return (
                        <button
                            key={option}
                            type="button"
                            className="h-8 rounded-full border px-2.5 text-sm transition hover:opacity-80"
                            style={{ borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }}
                            onClick={() => onChange(option)}
                        >
                            {option}
                        </button>
                    );
                })}
            </span>
        );
    }
    return (
        <span className="flex items-center gap-1.5">
            <span className="text-xs opacity-55">{label}</span>
            <input
                type="number"
                className="h-8 w-20 rounded-full border bg-transparent px-2 text-sm"
                style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                value={String(current ?? "")}
                onChange={(event) => onChange(Number(event.target.value))}
            />
        </span>
    );
}
