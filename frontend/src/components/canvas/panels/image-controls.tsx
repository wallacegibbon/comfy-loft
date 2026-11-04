import { BaseModelPicker, WorkflowModelPicker } from "@/components/model-picker";

import { CanvasImageSettingsPopover } from "../canvas-image-settings-popover";
import type { NodeControlsProps } from "./node-controls-props";

/**
 * The controls an image node's panel shows beside its prompt: which workflow, which base model, and the
 * settings that workflow has (size, mode, layout, and the editors that make a new node).
 *
 * The settings popover is one component for every image workflow; which of its sections appear is its own
 * decision, made from what the selected workflow declares.
 */
export function ImageControls({ node, config, onConfigChange, onOpenPreferences, onImageSettingsOpenChange, onOpenMaskEditor, onOpenOutpaintEditor, onOpenMossLayoutEditor }: NodeControlsProps) {
    return (
        <>
            <WorkflowModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="image" onMissingConfig={onOpenPreferences} className="max-w-[190px]" />
            <BaseModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} className="max-w-[140px]" />
            <CanvasImageSettingsPopover
                config={config}
                placement="topLeft"
                buttonClassName="!h-10 !max-w-[170px] !justify-start !rounded-full !px-3"
                onConfigChange={(key, value) => onConfigChange(node.id, { [key]: value })}
                onParamsChange={(params) => onConfigChange(node.id, { params: { ...node.metadata?.params, ...params } })}
                onMissingConfig={onOpenPreferences}
                onOpenChange={onImageSettingsOpenChange}
                onOpenMaskEditor={() => onOpenMaskEditor?.(node.id)}
                onOpenOutpaintEditor={() => onOpenOutpaintEditor?.(node.id)}
                onOpenMossLayoutEditor={() => onOpenMossLayoutEditor?.(node.id)}
            />
        </>
    );
}
