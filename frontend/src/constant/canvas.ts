import { CanvasNodeType } from "@/types/canvas";
import type { CanvasNodeMetadata } from "@/types/canvas";
import { getNodeSpec as getRegistryNodeSpec } from "@/lib/canvas/node-registry";

type CanvasNodeSpec = {
    width: number;
    height: number;
    metadata?: CanvasNodeMetadata;
};

export const NODE_DEFAULT_SIZE = {
    [CanvasNodeType.Image]: {
        width: 340,
        height: 240,
    },
    [CanvasNodeType.Text]: {
        width: 340,
        height: 240,
    },
    [CanvasNodeType.Video]: {
        width: 420,
        height: 236,
    },
    [CanvasNodeType.Audio]: {
        width: 340,
        height: 120,
    },
    [CanvasNodeType.Lora]: {
        width: 260,
        height: 120,
    },
    [CanvasNodeType.Group]: {
        width: 760,
        height: 480,
    },
} satisfies Record<CanvasNodeType, { width: number; height: number }>;

export const NODE_SPECS = {
    [CanvasNodeType.Image]: {
        width: 340,
        height: 240,
        metadata: { content: "", status: "idle" },
    },
    [CanvasNodeType.Text]: {
        width: 340,
        height: 240,
        metadata: { content: "", status: "idle", fontSize: 14 },
    },
    [CanvasNodeType.Video]: {
        width: 420,
        height: 236,
        metadata: { content: "", status: "idle" },
    },
    [CanvasNodeType.Audio]: {
        width: 340,
        height: 120,
        metadata: { content: "", status: "idle" },
    },
    [CanvasNodeType.Lora]: {
        width: 260,
        height: 120,
        metadata: { status: "idle", params: { loras: [] } },
    },
    [CanvasNodeType.Group]: {
        width: 760,
        height: 480,
        metadata: { status: "idle" },
    },
} satisfies Record<CanvasNodeType, CanvasNodeSpec>;

// Return the spec a node type was registered with, or a neutral fallback for a type this build lacks.
export function getNodeSpec(type: string) {
    if ((Object.values(CanvasNodeType) as string[]).includes(type)) return NODE_SPECS[type as CanvasNodeType];
    const spec = getRegistryNodeSpec(type);
    return { width: spec.width, height: spec.height, metadata: spec.metadata };
}
