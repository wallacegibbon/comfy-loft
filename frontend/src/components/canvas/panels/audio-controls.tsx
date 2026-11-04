import { ModelPicker } from "@/components/model-picker";

import { CanvasAudioSettingsPopover, type CanvasAudioSettingKey } from "../canvas-audio-settings-popover";
import type { NodeControlsProps } from "./node-controls-props";

/** The controls an audio node's panel shows beside its prompt: which model, and its format and length. */
export function AudioControls({ node, config, onConfigChange, onOpenPreferences }: NodeControlsProps) {
    return (
        <>
            <ModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="audio" onMissingConfig={onOpenPreferences} className="max-w-[190px]" />
            <CanvasAudioSettingsPopover config={config} buttonClassName="!h-10 !max-w-[170px] !justify-start !rounded-full !px-3" onConfigChange={(key, value) => onConfigChange(node.id, audioConfigPatch(key, value))} />
        </>
    );
}

/** The audio popover speaks in `audio…` setting names; a node stores them without the prefix. */
function audioConfigPatch(key: CanvasAudioSettingKey, value: string) {
    if (key === "audioFormat") return { audioFormat: value };
    if (key === "audioSeconds") return { seconds: value };
    return { audioInstructions: value };
}
