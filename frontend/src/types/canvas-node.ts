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
 * The optional fields are what makes one node definition different from another, and every one of them is
 * read by the canvas: the creation menus, the panel a click opens, the ratio a resize keeps, the resource
 * it contributes downstream. A flag nothing sets is a branch nothing takes, so there are none.
 */
export type CanvasNodeDefinition = {
    type: string;
    title: string;
    icon: ReactNode;
    defaultSize: { width: number; height: number };
    defaultMetadata?: CanvasNodeMetadata;
    minimapColor?: string;
    insertBefore?: boolean; // Created upstream: the creation menu connects it into the node being referenced.
    autoOpenPanel?: boolean; // Opens the node's panel on click.
    /** A card that frames a picture or a film is that content's shape: dragging a corner scales it, and only these types say so. */
    keepsAspectRatio?: boolean;
    resource?: (node: CanvasNodeData) => CanvasNodeResource | null;
};

/** What a node contributes to whatever it is wired into. */
export type CanvasNodeResource = { kind: CanvasResourceKind; text?: string; url?: string; loras?: Array<{ name: string; strength: number }> };
