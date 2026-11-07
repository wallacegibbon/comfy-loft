import type { CanvasNodeDefinition } from "@/types/canvas-node";
import { CanvasNodeType } from "@/types/canvas";

/**
 * The node types this build has.
 *
 * One map, filled once at module load by `registerBuiltinNodes()` and read by everything that has to know
 * what a node is: creation menus, default sizes, handle placement, the side panel, export. It used to be
 * two kinds of entry — built-in and whatever a plugin registered — with an owner map and a change
 * notification so a late registration could re-render the menus. Both went with the plugin mechanism
 * (#148): registration now happens before the first render, so there is nothing to notify.
 */
const definitions = new Map<string, CanvasNodeDefinition>();

export function registerNodeDefinitions(defs: CanvasNodeDefinition[]) {
    defs.forEach((def) => definitions.set(def.type, def));
}

export function getNodeDefinition(type: string) {
    return definitions.get(type);
}

export function listNodeDefinitions() {
    return Array.from(definitions.values());
}

export function isBuiltinNodeType(type: string) {
    return (Object.values(CanvasNodeType) as string[]).includes(type);
}
