import { channelModelOf, type AiConfig } from "@/stores/use-config-store";

/**
 * The mode an image run will actually use.
 *
 * A node keeps its `imageMode` after the model under it is changed, so a node that was set to "inpaint" on
 * Qwen keeps saying "inpaint" when it is pointed at a workflow that has one mode and no mask binding. The
 * panel clamped that for what it displays; the request did not, and sent a mask role and outpaint numbers to
 * a graph that binds neither — accepted and ignored, or refused, depending on the workflow (#267).
 *
 * So the mode is resolved against what the model declares: the node's choice when the model offers it, the
 * workflow's text-to-image mode when it has one (`t2i` needs nothing, which is what makes it the fallback
 * rather than whichever mode sorts first), and nothing at all for a workflow with no modes — the field is
 * then simply not sent.
 *
 * A mode the server reports as blocked is still resolved and still sent: the run refuses it with its own
 * reason (a missing node pack), and quietly turning the request into a different mode would hide that.
 */
export function imageModeFor(config: AiConfig, model: string) {
    const modes = channelModelOf(config, model)?.model.variantModes;
    if (!modes?.length) return "";
    const chosen = String(config.imageMode || "");
    if (modes.includes(chosen)) return chosen;
    return modes.includes(TEXT_TO_IMAGE_MODE) ? TEXT_TO_IMAGE_MODE : modes[0];
}

/** The mode that needs nothing but words: no reference, no mask, no padding. */
const TEXT_TO_IMAGE_MODE = "t2i";
