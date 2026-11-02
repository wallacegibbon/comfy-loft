import { create } from "zustand";

import i18n from "@/i18n";
import { documentOf } from "@/lib/canvas/canvas-document";
import { createSaveQueue, type SaveQueue } from "@/lib/canvas/save-queue";
import { emptyCanvasDocument, requestCanvas, requestCanvasCreate, requestCanvasDelete, requestCanvasImport, requestCanvasSave, requestCanvases, type CanvasDocument, type CanvasSummary } from "@/services/api/canvases";

/**
 * The canvases, as a cache over the directories the gateway owns.
 *
 * The store used to be the truth: everything lived in the browser, and IndexedDB was written on a
 * debounce. Since #152 the document lives in `<CANVAS_ROOT>/<id>/canvas.json`, so this holds two
 * different things and they must not be confused:
 *
 *   - `canvases` — the list the gateway reports. Metadata only: no nodes, no viewport. It is what the
 *     top bar's switcher and the canvas list render, and it is refreshed, never merged into.
 *   - `projects` — the documents this session has actually loaded. A canvas that is not here has not
 *     been opened, and nothing may assume otherwise: the sweep that used to collect unused media by
 *     walking every project was deleted for exactly this reason (#154 brings it back on the gateway).
 *
 * Every write goes through `save-queue.ts`, which coalesces, serializes per canvas and retries with
 * `If-Match`. Nothing in here writes a document anywhere else.
 */

export type CanvasProject = CanvasDocument & CanvasSummary;

type CanvasStore = {
    /** The first list has arrived (or failed): the canvas list can be shown. */
    ready: boolean;
    canvases: CanvasSummary[];
    /** Documents loaded this session, at most one per canvas. */
    projects: CanvasProject[];
    /** The last save failure per canvas, as a message the UI can show. */
    saveErrors: Record<string, string>;
    /**
     * Canvases whose copy on disk is not the one this tab holds: another tab saved, and this store
     * refused to overwrite it. The value is the summary the gateway reported, so the dialog can say
     * when it changed. Nothing on screen is lost until the person answers.
     */
    conflicts: Record<string, CanvasSummary>;
    refresh: () => Promise<void>;
    loadCanvas: (id: string, options?: { force?: boolean }) => Promise<CanvasProject | null>;
    /**
     * Create a canvas. The document travels with it, so a canvas never exists in a state where opening it
     * and reading it disagree — and an import is one request, not a create plus a save.
     */
    createCanvas: (title?: string, document?: CanvasDocument) => Promise<string>;
    /**
     * Restore an exported canvas from its archive. The gateway unpacks it into a new canvas directory and
     * answers with that canvas, so this is one request: no files to rename here (decisions #172).
     */
    importCanvas: (archive: Blob) => Promise<string>;
    renameCanvas: (id: string, title: string) => Promise<void>;
    deleteCanvases: (ids: string[]) => Promise<void>;
    updateProject: (id: string, patch: Partial<CanvasDocument>) => void;
    clearSaveError: (id: string) => void;
    /** Keep what is on screen: save over the copy on disk, deliberately, with no version precondition. */
    resolveConflictWithMine: (id: string) => Promise<void>;
    /** Re-read the canvas list entry and mark the canvas if the disk moved on without us. */
    checkForNewerCopy: (id: string) => Promise<void>;
};

function projectOf(summary: CanvasSummary, document: CanvasDocument): CanvasProject {
    return { ...document, ...summary };
}

/** Replace a summary in place, or put it first when it is new. */
function upsertSummary(canvases: CanvasSummary[], summary: CanvasSummary): CanvasSummary[] {
    const found = canvases.some((item) => item.id === summary.id);
    return found ? canvases.map((item) => (item.id === summary.id ? summary : item)) : [summary, ...canvases];
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * The queue lives here rather than inside the store so that `updateProject` can call it without a
 * hook, and so it survives a project being swapped out from under it. Its callbacks read the store
 * through `getState`, never through a captured snapshot.
 */
const queue: SaveQueue = createSaveQueue({
    snapshot: (id) => {
        const state = useCanvasStore.getState();
        const project = state.projects.find((item) => item.id === id);
        if (!project) return null;
        const summary = state.canvases.find((item) => item.id === id);
        return { document: documentOf(project), rev: summary?.rev ?? project.rev, title: project.title };
    },
    save: (id, snapshot, options) => requestCanvasSave(id, snapshot.rev, snapshot.document, snapshot.title, options),
    onSaved: (id, summary) => {
        useCanvasStore.setState((state) => ({
            canvases: state.canvases.map((item) => (item.id === id ? summary : item)),
            projects: state.projects.map((project) => (project.id === id ? { ...project, ...summary } : project)),
            saveErrors: withoutKey(state.saveErrors, id),
        }));
    },
    onConflict: (id, current) => {
        // The document on disk moved on and this tab's copy did not. Nothing is overwritten and nothing
        // is retried: the canvas is marked and the person decides which copy wins (#158).
        useCanvasStore.setState((state) => ({ conflicts: { ...state.conflicts, [id]: current } }));
    },
    onMissing: (id) => {
        useCanvasStore.setState((state) => ({
            // The document stays in `projects` on purpose: the user is looking at it, and the nodes on
            // screen are the only copy left. Removing it from the list stops it being offered again;
            // the open canvas keeps working as a scratch surface that can still be exported.
            canvases: state.canvases.filter((item) => item.id !== id),
            saveErrors: { ...state.saveErrors, [id]: i18n.t("canvas.save.missing") },
        }));
    },
    onError: (id, error) => {
        useCanvasStore.setState((state) => ({ saveErrors: { ...state.saveErrors, [id]: messageOf(error) } }));
    },
});

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
    if (!(key in record)) return record;
    const next = { ...record };
    delete next[key];
    return next;
}

export const useCanvasStore = create<CanvasStore>()((set, get) => ({
    ready: false,
    canvases: [],
    projects: [],
    saveErrors: {},
    conflicts: {},

    // `ready` flips even when the list cannot be read: the canvas page has its own reconnect banner,
    // and a list that never becomes ready would hold the app on a blank screen while the gateway
    // starts. An empty list is a truthful answer to "what is there", and the retry is the banner's job.
    refresh: async () => {
        try {
            const canvases = await requestCanvases();
            set({ canvases, ready: true });
        } catch {
            set({ ready: true });
        }
    },

    loadCanvas: async (id, options) => {
        const cached = get().projects.find((project) => project.id === id);
        if (cached && !options?.force) return cached;
        const record = await requestCanvas(id);
        if (!record) return null;
        const project = projectOf(record.summary, record.document);
        set((state) => ({
            projects: [project, ...state.projects.filter((item) => item.id !== id)],
            canvases: upsertSummary(state.canvases, record.summary),
        }));
        return project;
    },

    // A failure is thrown: the caller is a dialog with a toast, and a canvas that silently did not get
    // created is worse than an error message.
    createCanvas: async (title = i18n.t("canvas.project.untitled"), document = emptyCanvasDocument()) => {
        const record = await requestCanvasCreate(title, document);
        const project = projectOf(record.summary, record.document);
        set((state) => ({ canvases: upsertSummary(state.canvases, record.summary), projects: [project, ...state.projects] }));
        return record.summary.id;
    },

    // An archive is one canvas. Nothing in it names a canvas id, so the gateway picks a new one and the
    // document is stored as it came out of the zip.
    importCanvas: async (archive) => {
        const record = await requestCanvasImport(archive);
        const project = projectOf(record.summary, record.document);
        set((state) => ({ canvases: upsertSummary(state.canvases, record.summary), projects: [project, ...state.projects] }));
        return record.summary.id;
    },

    // A rename can arrive from the canvas list, where the document was never loaded, so it loads
    // first: the title travels with a save, and a save needs a document.
    renameCanvas: async (id, title) => {
        const trimmed = title.trim();
        if (!trimmed) return;
        const project = await get().loadCanvas(id);
        if (!project) return;
        const now = new Date().toISOString();
        set((state) => ({
            projects: state.projects.map((item) => (item.id === id ? { ...item, title: trimmed, updatedAt: now } : item)),
            canvases: state.canvases.map((item) => (item.id === id ? { ...item, title: trimmed, updatedAt: now } : item)),
        }));
        queue.schedule(id);
    },

    // Deleting forgets the queue entry first: a queued save would otherwise land after the delete and
    // answer 404 with a retry. The list is only changed once the gateway has agreed, so a failed delete
    // leaves the canvas where it was.
    deleteCanvases: async (ids) => {
        const removing = new Set(ids);
        ids.forEach((id) => queue.forget(id));
        await Promise.all(ids.map((id) => requestCanvasDelete(id)));
        set((state) => ({
            canvases: state.canvases.filter((item) => !removing.has(item.id)),
            projects: state.projects.filter((item) => !removing.has(item.id)),
        }));
    },

    // The one write path for a canvas that is open. `updatedAt` moves locally so the list re-sorts
    // under the user's hand; the gateway's own timestamp replaces it when the save lands.
    updateProject: (id, patch) => {
        const now = new Date().toISOString();
        set((state) => ({
            projects: state.projects.map((project) => (project.id === id ? { ...project, ...patch, updatedAt: now } : project)),
            canvases: state.canvases.map((item) => (item.id === id ? { ...item, updatedAt: now } : item)),
        }));
        queue.schedule(id);
    },

    clearSaveError: (id) => set((state) => ({ saveErrors: withoutKey(state.saveErrors, id) })),

    // The one save that names no version, on purpose: the person was shown what it replaces and said to
    // go ahead. Everything else keeps its `If-Match`.
    resolveConflictWithMine: async (id) => {
        const project = get().projects.find((item) => item.id === id);
        if (!project) return;
        queue.forget(id);
        const saved = await requestCanvasSave(id, "", documentOf(project), project.title);
        set((state) => ({
            canvases: state.canvases.map((item) => (item.id === id ? saved : item)),
            projects: state.projects.map((item) => (item.id === id ? { ...item, ...saved } : item)),
            conflicts: withoutKey(state.conflicts, id),
        }));
    },

    // Cheaper than a subscription and it fires exactly when the mistake happens: the moment the person
    // switches to the tab. One GET of the entry; no document.
    checkForNewerCopy: async (id) => {
        if (get().conflicts[id]) return;
        const known = get().canvases.find((item) => item.id === id);
        if (!known) return;
        const record = await requestCanvas(id).catch(() => null);
        if (!record || record.summary.rev === known.rev) return;
        set((state) => ({ conflicts: { ...state.conflicts, [id]: record.summary } }));
    },
}));

/**
 * Write out whatever is queued.
 *
 * Called when the page is going away. It cannot wait for the answer — nothing survives the unload —
 * but the requests are on their way, and a debounce lost in flight is the one kind of data loss this
 * whole design exists to prevent.
 */
export function flushCanvasSaves() {
    void queue.flushAll();
}
