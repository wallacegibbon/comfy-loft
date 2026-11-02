import { loadLegacyAssetLibrary, legacyAssetFileKeys } from "@/lib/canvas/legacy-asset-store";
import { cleanupUnusedMedia } from "@/services/file-storage";
import { cleanupUnusedImages } from "@/services/image-storage";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

/**
 * Delete the blobs that no canvas refers to any more.
 *
 * The canvases are the only root. A file survives exactly as long as some node's `storageKey` does,
 * which is the same rule that decides whether it is in the export zip: what is on a canvas is what
 * exists. There is no second bookkeeping layer to keep in step — dragging a file onto the canvas is
 * what makes it part of the workspace, and deleting the node is what ends it.
 *
 * Callers pass whatever is still reachable but not yet in the store — an undo snapshot, the nodes of
 * a project that was just deleted — so that a delete stays undoable instead of being garbage
 * collected out from under the undo stack.
 *
 * Deferred by a tick, and everything reachable is read inside it rather than taken as an argument:
 * the caller has usually just written the new project list, and the sweep must see that write.
 */
export function sweepUnusedCanvasFiles(extra?: unknown) {
    window.setTimeout(async () => {
        // One more root while it lasts: the asset library `legacy-asset-store.ts` still holds a copy
        // of. Its files are referenced by nothing else, so without this the first sweep after #144
        // would delete media the user has not been offered a chance to export yet. The key goes away
        // with `discardLegacyAssetLibrary`, and from then on this costs one empty `getItem`.
        const legacy = await loadLegacyAssetLibrary();
        // Shaped as records rather than a list of keys: both collectors find roots by looking for a
        // `storageKey` property, so a bare array of strings would keep nothing alive.
        const legacyRoots = legacy ? legacyAssetFileKeys(legacy.assets).map((storageKey) => ({ storageKey })) : [];
        const used = { projects: useCanvasStore.getState().projects, extra, legacy: legacyRoots };
        await cleanupUnusedImages(used);
        await cleanupUnusedMedia(used);
    }, 0);
}
