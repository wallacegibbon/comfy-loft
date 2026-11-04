import { BaseModelPicker, WorkflowModelPicker } from "@/components/model-picker";
import type { AiConfig } from "@/stores/use-config-store";
import { videoModelModePatch } from "@/lib/canvas/video-model-mode";

import { CanvasVideoSettingsPopover } from "../canvas-video-settings-popover";
import type { NodeControlsProps } from "./node-controls-props";

/**
 * The controls a video node's panel shows beside its prompt: which workflow, which base model, and the
 * settings that workflow has (resolution, size, seconds, mode, and the SelfLift pills where it declares them).
 *
 * Picking another workflow writes the mode with it (`videoModelModePatch`), so a node can never claim a mode
 * its workflow does not run in.
 */
export function VideoControls({ node, config, onConfigChange, onOpenPreferences, frameMode, onVideoModeChange, sourceDurationSeconds }: NodeControlsProps) {
    return (
        <>
            <WorkflowModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, videoModelModePatch(config, model))} capability="video" onMissingConfig={onOpenPreferences} className="max-w-[190px]" />
            <BaseModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} className="max-w-[140px]" />
            <CanvasVideoSettingsPopover
                config={config}
                buttonClassName="!h-10 !min-w-0 !max-w-[200px] !justify-start !rounded-full !px-2"
                onConfigChange={(key, value) => onConfigChange(node.id, videoConfigPatch(key, value))}
                frameMode={frameMode}
                onFrameModeChange={(value) => onConfigChange(node.id, { frameMode: value })}
                onModeChange={onVideoModeChange}
                sourceDurationSeconds={sourceDurationSeconds}
            />
        </>
    );
}

/** The video popover speaks in `video…` setting names; a node stores them without the prefix. */
function videoConfigPatch(key: keyof AiConfig, value: string) {
    if (key === "videoSeconds") return { seconds: value };
    if (key === "videoGenerateAudio") return { generateAudio: value };
    if (key === "videoWatermark") return { watermark: value };
    if (key === "videoMode") return { videoMode: value };
    if (key === "videoSelfLiftMode") return { videoSelfLiftMode: value };
    return { [key]: value };
}
