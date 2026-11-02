import type { ReactNode } from "react";

import type { CanvasResourceKind } from "@/lib/canvas/canvas-resource-references";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

/**
 * What a node type is, for the one registry that holds them all.
 *
 * This used to be the plugin contract: a plugin package returned `CanvasNodeDefinition`s and the host
 * rendered whatever it was handed. There are no plugins any more (docs/decisions.md #148), so the same
 * shape is now simply the internal description of a built-in node — which is why `type` is a
 * `CanvasNodeType` and not an open string.
 *
 * The optional fields are what makes one node definition different from another; every one of them is
 * read by the canvas (creation menus, handles, panels, the resource it contributes downstream).
 */
export type CanvasNodeDefinition = {
    type: string;
    title: string;
    icon: ReactNode;
    description?: string;
    defaultSize: { width: number; height: number };
    defaultMetadata?: CanvasNodeMetadata;
    minimapColor?: string;
    showInCreateMenu?: boolean; // Defaults to true.
    insertBefore?: boolean; // Created upstream: the creation menu connects it into the node being referenced.
    hasSourceHandle?: boolean; // Right-side output handle; defaults to true.
    hidePanel?: boolean; // Prevents click/create from opening a lower panel; intended for display-only nodes.
    transparentBackground?: boolean; // Makes the node card transparent so SVG or vector content blends into the canvas.
    autoOpenPanel?: boolean; // Opens the node's panel on click.
    useBuiltinPanel?: CanvasBuiltinPanelConfig; // Reuses the built-in generation panel.
    // Lets the host provide an Interaction/Move toolbar toggle and control pointer events through metadata.interactive.
    interactionToggle?: boolean;
    // With interactionToggle, true forces interactive content, ignores metadata.interactive, and hides the toggle.
    forceInteractive?: (node: CanvasNodeData) => boolean;
    keepAspectRatio?: (node: CanvasNodeData) => boolean;
    resource?: (node: CanvasNodeData) => CanvasNodeResource | null;
};

/** Configuration for reusing the host's built-in generation panel on a node that is not really one. */
type CanvasBuiltinPanelConfig = {
    mode: "image" | "video" | "text" | "audio";
    promptPrefix?: string;
    writeBackToSelf?: boolean;
};

/** One button a node can contribute to its own hover toolbar. */
export type CanvasNodeToolbarItem = {
    id: string;
    title: string;
    label: string;
    icon: ReactNode;
    onClick: () => void;
    active?: boolean;
    danger?: boolean;
};

/** What a node contributes to whatever it is wired into. */
export type CanvasNodeResource = { kind: CanvasResourceKind; text?: string; url?: string; loras?: Array<{ name: string; strength: number }> };
