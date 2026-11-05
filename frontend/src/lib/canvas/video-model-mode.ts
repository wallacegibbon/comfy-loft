import { channelModelOf, workflowModelOptions, type AiConfig } from "@/stores/use-config-store";
import type { CanvasNodeData } from "@/types/canvas";

/**
 * The video model that runs in a mode, found by the mode the workflow declares.
 *
 * Switching the composer's mode used to mean naming the workflow to switch to (`video-h3-ref2va` for
 * `reference`), which made a table of ids the price of one dropdown. The declarations are already on the
 * wire, so this asks them: the first model whose `mode` is the one asked for.
 */
export function videoModelForMode(config: AiConfig, mode: string) {
    const optionsList = workflowModelOptions(config, "video");
    return optionsList.find((value) => channelModelOf(config, value)?.model.mode === mode) || "";
}

/**
 * Whether the length of a video is the user's to choose.
 *
 * True when the selected workflow binds nothing to `seconds` — a character swap takes its length from the
 * clip being edited, so a seconds control would be a number nothing reads. A model the server did not list
 * answers `false` (nothing is claimed about it), which is why the field is three-state rather than boolean.
 */
export function videoFollowsSource(config: AiConfig, model: string) {
    return channelModelOf(config, model)?.model.bindsSeconds === false;
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
