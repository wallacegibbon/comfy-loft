import { channelModelOf, modelOptionName, workflowModelOptions, type AiConfig } from "@/stores/use-config-store";
import type { CanvasNodeData } from "@/types/canvas";

export function videoWorkflowId(config: AiConfig, model: string) {
    return channelModelOf(config, model)?.model.workflowId || modelOptionName(model);
}

export function videoModelForWorkflow(config: AiConfig, workflowId: string) {
    const optionsList = workflowModelOptions(config, "video");
    return optionsList.find((value) => videoWorkflowId(config, value) === workflowId) || "";
}

/**
 * The mode a video workflow runs in, written alongside the model it was picked with.
 *
 * The workflow declares it (`mode: text | frames | reference` in the registry), so this reads that instead
 * of recognising ids: `video-h3-frames` used to be spelled out here, and every new workflow with a mode
 * would have had to be added to the list. A workflow that declares none — an interpolation, which has no
 * modes — gets the model and nothing else.
 */
export function videoModelModePatch(config: AiConfig, model: string): Partial<NonNullable<CanvasNodeData["metadata"]>> {
    const mode = channelModelOf(config, model)?.model.mode;
    return mode ? { model, videoMode: mode } : { model };
}
