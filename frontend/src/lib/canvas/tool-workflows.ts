/**
 * Workflows that are a *step*: they take a clip or a picture and a knob, and have nothing to be asked.
 *
 * This list is a **presentation choice and it lives in the client**, because the canvas is the only
 * client. The server registers a workflow and reports whether it can run; recognising the ones the canvas
 * also has a button for is ours.
 *
 * Being on this list does *not* hide a workflow any more — a node can be one, and that is how an
 * interpolation node exists at all. It marks it as unusable as a **default** for new nodes
 * (`defaultModelOptions`), because a default has to run from a prompt. Keeping the ids in one place means a
 * tool cannot drift: the same constant names the button, builds the request, and marks the model entry.
 */
export const VIDEO_INTERPOLATE_WORKFLOW = "video-rife";
export const IMAGE_UPSCALE_WORKFLOW = "image-esrgan-upscale";
export const IMAGE_ANGLE_WORKFLOW = "image-qwen21-angle";

const TOOL_WORKFLOWS: readonly string[] = [VIDEO_INTERPOLATE_WORKFLOW, IMAGE_UPSCALE_WORKFLOW, IMAGE_ANGLE_WORKFLOW];

/** Whether a workflow is a step the canvas also has a button for (never a *default*, but still a node's model). */
export function isToolWorkflow(id: string) {
    return TOOL_WORKFLOWS.includes(id);
}
