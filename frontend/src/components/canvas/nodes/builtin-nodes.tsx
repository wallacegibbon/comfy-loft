import { FileText, Group, Image as ImageIcon, Music2, SlidersHorizontal, Video } from "lucide-react";

import i18n from "@/i18n";

import { NODE_SPECS } from "@/constant/canvas";
import { registerNodeDefinitions } from "@/lib/canvas/node-registry";
import { nodeContentOf } from "@/lib/canvas/node-prompt-field";
import { loraResource } from "@/components/canvas/nodes/lora-node";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { CanvasNodeDefinition, CanvasNodeResource } from "@/types/canvas-node";

// Extensible metadata for built-in nodes, reusing NODE_SPECS for size and initial metadata.
// Rendering remains in canvas-node's internal renderer, so no Content component is provided.
//
// What a node gives away is its content and only its content: a picture gives the picture, a text node
// gives the words on its card, a LoRA gives its choice — and a node that holds nothing gives nothing. Its
// prompt is what it was asked, which is nobody else's business (#230).
function builtinResource(node: CanvasNodeData): CanvasNodeResource | null {
    if (node.type === CanvasNodeType.Image && node.metadata?.content) return { kind: "image", url: node.metadata.content };
    if (node.type === CanvasNodeType.Video && node.metadata?.content) return { kind: "video", url: node.metadata.content };
    if (node.type === CanvasNodeType.Audio && node.metadata?.content) return { kind: "audio", url: node.metadata.content };
    if (node.type === CanvasNodeType.Text) {
        const text = nodeContentOf(node);
        return text ? { kind: "text", text } : null;
    }
    return null;
}

const iconClass = "size-4";

const BUILTIN_DEFINITIONS: CanvasNodeDefinition[] = [
    { type: CanvasNodeType.Text, title: i18n.t("canvas.nodeTypes.text"), icon: <FileText className={iconClass} />, minimapColor: undefined, resource: builtinResource },
    { type: CanvasNodeType.Image, title: i18n.t("canvas.nodeTypes.image"), icon: <ImageIcon className={iconClass} />, minimapColor: "#10b981", keepAspectRatio: (node: CanvasNodeData) => !node.metadata?.freeResize, resource: builtinResource },
    { type: CanvasNodeType.Video, title: i18n.t("canvas.nodeTypes.video"), icon: <Video className={iconClass} />, minimapColor: "#f97316", keepAspectRatio: () => true, resource: builtinResource },
    { type: CanvasNodeType.Audio, title: i18n.t("canvas.nodeTypes.audio"), icon: <Music2 className={iconClass} />, minimapColor: "#a855f7", resource: builtinResource },
    {
        // A LoRA is a choice about the model, so it is its own card: one card wired into two nodes is how a
        // stack gets reused. `insertBefore` puts it upstream of the node it is created from.
        type: CanvasNodeType.Lora,
        title: i18n.t("canvas.nodeTypes.lora"),
        icon: <SlidersHorizontal className={iconClass} />,
        minimapColor: "#eab308",
        insertBefore: true,
        autoOpenPanel: true,
        resource: loraResource,
    },
    { type: CanvasNodeType.Group, title: i18n.t("canvas.node.group"), icon: <Group className={iconClass} />, minimapColor: "#94a3b8" },
].map((def) => {
    const spec = NODE_SPECS[def.type];
    return { ...def, title: spec.title, defaultSize: { width: spec.width, height: spec.height }, defaultMetadata: spec.metadata };
});

let registered = false;
export function registerBuiltinNodes() {
    if (registered) return;
    registered = true;
    registerNodeDefinitions(BUILTIN_DEFINITIONS);
}
