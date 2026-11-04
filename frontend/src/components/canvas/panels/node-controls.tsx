import type { ComponentType } from "react";

import type { CanvasGenerationMode } from "@/types/canvas";

import { AudioControls } from "./audio-controls";
import { ImageControls } from "./image-controls";
import type { NodeControlsProps } from "./node-controls-props";
import { TextControls } from "./text-controls";
import { VideoControls } from "./video-controls";

/**
 * Which controls a node's panel shows, one entry per generation kind.
 *
 * The panel used to hold this as a chain of `mode === … ? … : …` arms in the middle of its own JSX, which put
 * four different clusters of pickers in one function and left every kind's facts (the placeholder, whether the
 * button generates or connects an agent) as ternaries beside them. This is the same move the card itself
 * already made for its content (`nodeContentRenderers`): a static table, read at render, one component per
 * kind.
 *
 * It is a `Record` over the mode union rather than a registry with a `register` function: the compiler then
 * refuses a new kind without controls, and nothing here runs at startup. The canvas had a plugin mechanism
 * once and it was deleted (#148) — a table that is written out once is not that.
 */
export const NODE_CONTROLS: Record<CanvasGenerationMode, ComponentType<NodeControlsProps>> = {
    image: ImageControls,
    video: VideoControls,
    audio: AudioControls,
    text: TextControls,
};
