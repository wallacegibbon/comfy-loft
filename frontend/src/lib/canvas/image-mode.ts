import { channelModelOf, type AiConfig, type ChannelModel } from "@/stores/use-config-store";

/**
 * The mode an image run will actually use.
 *
 * A node keeps its `imageMode` after the model under it is changed, so a node that was set to "inpaint" on
 * Qwen keeps saying "inpaint" when it is pointed at a workflow that has one mode and no mask binding. The
 * panel clamped that for what it displays; the request did not, and sent a mask role and outpaint numbers to
 * a graph that binds neither — accepted and ignored, or refused, depending on the workflow (#267).
 *
 * So the mode is resolved against what the model declares: the node's choice when the model offers it, and
 * otherwise the mode whose contract asks for least (see `cheapestMode`), and nothing at all for a workflow
 * with no modes — the field is then simply not sent.
 *
 * A mode the server reports as blocked is still resolved and still sent: the run refuses it with its own
 * reason (a missing node pack), and quietly turning the request into a different mode would hide that.
 */
export function imageModeFor(config: AiConfig, model: string) {
    const channelModel = channelModelOf(config, model)?.model;
    const modes = channelModel?.variantModes;
    if (!channelModel || !modes?.length) return "";
    const chosen = String(config.imageMode || "");
    if (modes.includes(chosen)) return chosen;
    return cheapestMode(channelModel) || modes[0];
}

/**
 * The declared mode that asks the least of the caller: the one whose contract needs no reference, no mask and
 * no padding.
 *
 * This is what a stale `imageMode` falls back to, and it is deliberately not a name: the mode that means
 * "words only" is `t2i` in the Qwen family, and a family that never offers one still needs an answer. What the
 * canvas knows is the contracts, so the answer is the mode with the smallest minimum — the one a request is
 * least likely to be refused for. A family whose modes declare no contracts at all ties at zero and answers
 * with its first declared mode, which is at least the same answer every time.
 */
function cheapestMode(model: ChannelModel) {
    let best: { mode: string; cost: number } | undefined;
    for (const mode of model.variantModes || []) {
        const accepts = model.contracts?.[mode]?.accepts;
        const cost = (accepts?.images?.min ?? 0) + (accepts?.videos?.min ?? 0) + (accepts?.audios?.min ?? 0) + (accepts?.minTotal ?? 0);
        if (!best || cost < best.cost) best = { mode, cost };
    }
    return best?.mode || "";
}
