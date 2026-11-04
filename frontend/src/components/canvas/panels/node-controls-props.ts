import type { AiConfig } from "@/stores/use-config-store";
import type { CanvasNodeData } from "@/types/canvas";

/**
 * What a node's panel hands to the controls of one generation kind.
 *
 * The panel owns the shell — the reference bar, the prompt box, the agent button, the generate button — and a
 * kind owns only the cluster that sits beside the prompt box: which pickers, which settings popover. This type
 * is what both sides agree on, so the shell never asks what kind it is drawing.
 *
 * The optional members are the few that only one kind has (an image settings popover reports when it opens, a
 * video popover needs the source clip's length, a text node has an agent). A kind reads the ones it needs and
 * ignores the rest, which is cheaper to keep honest than four prop types that would differ by one field.
 */
export type NodeControlsProps = {
    node: CanvasNodeData;
    /** The node's own settings mixed over the user's defaults — what its pickers and popovers read. */
    config: AiConfig;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => void;
    onOpenPreferences: () => void;
    /** Image: the settings popover covers the panel while it is open, so the panel is told. */
    onImageSettingsOpenChange?: (open: boolean) => void;
    onOpenMaskEditor?: (nodeId: string) => void;
    onOpenOutpaintEditor?: (nodeId: string) => void;
    onOpenMossLayoutEditor?: (nodeId: string) => void;
    /** Video: which frames a run supplies, and the workflow a mode change should switch to. */
    frameMode?: "first" | "last" | "both";
    onVideoModeChange?: (value: "text" | "frames" | "reference") => void;
    /** Video: how long the clip being edited is, when the length follows it. */
    sourceDurationSeconds?: number;
    /** Text: the node's own agent, which is what answers a text node. */
    agentName?: string;
};
