import { CanvasNodeType } from "@/types/canvas";
import type { CanvasNodeMetadata } from "@/types/canvas";

type CanvasNodeSpec = {
    width: number;
    height: number;
    metadata?: CanvasNodeMetadata;
};

/**
 * What a node of each type starts as: its card's size, and the metadata it is born with.
 *
 * One table, and one lookup below it. It used to be two tables of the same numbers (`NODE_DEFAULT_SIZE` held
 * the width and height again for the callers that want only those) and two lookups (`getNodeSpec` here, and a
 * second one in `node-registry.ts` that read the registered definitions — which are built from *this* table, so
 * the registry's branch could only ever answer with what the table already said). The sizes are derived from
 * the specs now, which is why a number cannot be changed in one place and stay wrong in the other.
 */
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

/** The card's size for each type, for the callers that place a card and never look at its metadata. */
export const NODE_DEFAULT_SIZE = Object.fromEntries(Object.entries(NODE_SPECS).map(([type, spec]) => [type, { width: spec.width, height: spec.height }])) as Record<CanvasNodeType, { width: number; height: number }>;

/**
 * A spec for a type this build does not have.
 *
 * `CanvasNodeTypeId` is open on purpose (`types/canvas.ts`): a document written by a build that had one more
 * node type still opens, and a node whose card has no size is a node nobody can click. So the answer exists,
 * it is just neutral — no content, no prompt, nothing to draw it with.
 */
const UNKNOWN_NODE_SPEC: CanvasNodeSpec = { width: 340, height: 240, metadata: { status: "idle" } };

/** The spec a node of this type starts as. */
export function getNodeSpec(type: string): CanvasNodeSpec {
    return NODE_SPECS[type as CanvasNodeType] ?? UNKNOWN_NODE_SPEC;
}
