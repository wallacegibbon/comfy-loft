import i18n from "@/i18n";
import { CanvasNodeType } from "@/types/canvas";
import type { CanvasNodeMetadata } from "@/types/canvas";
import { getNodeSpec as getRegistryNodeSpec } from "@/lib/canvas/node-registry";

type CanvasNodeSpec = {
    width: number;
    height: number;
    title: string;
    /**
     * The key `title` was rendered from. A node stores it so the canvas reads in the current language
     * instead of the one it was created in (docs/decisions.md #70).
     */
    titleKey?: string;
    metadata?: CanvasNodeMetadata;
};

export const NODE_DEFAULT_SIZE = {
    [CanvasNodeType.Image]: {
        width: 340,
        height: 240,
        get title() {
            return i18n.t("canvas.nodeTypes.image");
        },
        titleKey: "canvas.nodeTypes.image",
    },
    [CanvasNodeType.Text]: {
        width: 340,
        height: 240,
        get title() {
            return i18n.t("canvas.nodeTypes.text");
        },
        titleKey: "canvas.nodeTypes.text",
    },
    [CanvasNodeType.Video]: {
        width: 420,
        height: 236,
        get title() {
            return i18n.t("canvas.nodeTypes.video");
        },
        titleKey: "canvas.nodeTypes.video",
    },
    [CanvasNodeType.Audio]: {
        width: 340,
        height: 120,
        get title() {
            return i18n.t("canvas.nodeTypes.audio");
        },
        titleKey: "canvas.nodeTypes.audio",
    },
    [CanvasNodeType.Lora]: {
        width: 260,
        height: 120,
        get title() {
            return i18n.t("canvas.nodeTypes.lora");
        },
        titleKey: "canvas.nodeTypes.lora",
    },
    [CanvasNodeType.Group]: {
        width: 760,
        height: 480,
        get title() {
            return i18n.t("canvas.nodeTypes.group");
        },
        titleKey: "canvas.node.group",
    },
} satisfies Record<CanvasNodeType, { width: number; height: number; title: string; titleKey: string }>;

export const NODE_SPECS = {
    [CanvasNodeType.Image]: {
        width: 340,
        height: 240,
        get title() {
            return NODE_DEFAULT_SIZE[CanvasNodeType.Image].title;
        },
        get titleKey() {
            return NODE_DEFAULT_SIZE[CanvasNodeType.Image].titleKey;
        },
        metadata: { content: "", status: "idle" },
    },
    [CanvasNodeType.Text]: {
        width: 340,
        height: 240,
        get title() {
            return NODE_DEFAULT_SIZE[CanvasNodeType.Text].title;
        },
        get titleKey() {
            return NODE_DEFAULT_SIZE[CanvasNodeType.Text].titleKey;
        },
        metadata: { content: "", status: "idle", fontSize: 14 },
    },
    [CanvasNodeType.Video]: {
        width: 420,
        height: 236,
        get title() {
            return NODE_DEFAULT_SIZE[CanvasNodeType.Video].title;
        },
        get titleKey() {
            return NODE_DEFAULT_SIZE[CanvasNodeType.Video].titleKey;
        },
        metadata: { content: "", status: "idle" },
    },
    [CanvasNodeType.Audio]: {
        width: 340,
        height: 120,
        get title() {
            return NODE_DEFAULT_SIZE[CanvasNodeType.Audio].title;
        },
        get titleKey() {
            return NODE_DEFAULT_SIZE[CanvasNodeType.Audio].titleKey;
        },
        metadata: { content: "", status: "idle" },
    },
    [CanvasNodeType.Lora]: {
        width: 260,
        height: 120,
        get title() {
            return NODE_DEFAULT_SIZE[CanvasNodeType.Lora].title;
        },
        get titleKey() {
            return NODE_DEFAULT_SIZE[CanvasNodeType.Lora].titleKey;
        },
        metadata: { status: "idle", params: { loras: [] } },
    },
    [CanvasNodeType.Group]: {
        width: 760,
        height: 480,
        get title() {
            return NODE_DEFAULT_SIZE[CanvasNodeType.Group].title;
        },
        get titleKey() {
            return NODE_DEFAULT_SIZE[CanvasNodeType.Group].titleKey;
        },
        metadata: { status: "idle" },
    },
} satisfies Record<CanvasNodeType, CanvasNodeSpec>;

// Return the spec a node type was registered with, or a neutral fallback for a type this build lacks.
export function getNodeSpec(type: string) {
    if ((Object.values(CanvasNodeType) as string[]).includes(type)) return NODE_SPECS[type as CanvasNodeType];
    const spec = getRegistryNodeSpec(type);
    return { width: spec.width, height: spec.height, title: spec.title, metadata: spec.metadata };
}
