import { create } from "zustand";

import i18n from "@/i18n";
import { createSaveQueue, type SaveQueue } from "@/lib/canvas/save-queue";
import { emptyCanvasDocument, requestCanvas, requestCanvasCreate, requestCanvasDelete, requestCanvasSave, requestCanvases, type CanvasDocument, type CanvasSummary } from "@/services/api/canvases";

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
    /** The last save failure or version race per canvas, as a message the UI can show. */
    saveErrors: Record<string, string>;
    refresh: () => Promise<void>;
    loadCanvas: (id: string) => Promise<CanvasProject | null>;
    createCanvas: (title?: string) => Promise<string>;
    importCanvas: (source: Partial<CanvasDocument> & { title?: string }) => Promise<string>;
    renameCanvas: (id: string, title: string) => Promise<void>;
    deleteCanvases: (ids: string[]) => Promise<void>;
    updateProject: (id: string, patch: Partial<CanvasDocument>) => void;
    clearSaveError: (id: string) => void;
};

/** The document half of a project: what belongs in `canvas.json`, without the gateway's own fields. */
function documentOf(project: CanvasProject): CanvasDocument {
    return {
        nodes: project.nodes,
        connections: project.connections,
        backgroundMode: project.backgroundMode,
        showImageInfo: project.showImageInfo,
        viewport: project.viewport,
    };
}

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
    save: (id, snapshot) => requestCanvasSave(id, snapshot.rev, snapshot.document, snapshot.title),
    onSaved: (id, summary) => {
        useCanvasStore.setState((state) => ({
            canvases: state.canvases.map((item) => (item.id === id ? summary : item)),
            projects: state.projects.map((project) => (project.id === id ? { ...project, ...summary } : project)),
            saveErrors: withoutKey(state.saveErrors, id),
        }));
    },
    onConflict: (id, current) => {
        // The content on screen is still unsaved, so the queue retries; what has to change first is
        // the version the retry names. The user is told, because their edit replaced someone else's.
        useCanvasStore.setState((state) => ({
            canvases: upsertSummary(state.canvases, current),
            projects: state.projects.map((project) => (project.id === id ? { ...project, ...current } : project)),
            saveErrors: { ...state.saveErrors, [id]: i18n.t("canvas.save.conflict") },
        }));
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

function withoutKey(record: Record<string, string>, key: string): Record<string, string> {
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

    loadCanvas: async (id) => {
        const cached = get().projects.find((project) => project.id === id);
        if (cached) return cached;
        const record = await requestCanvas(id);
        if (!record) return null;
        const project = projectOf(record.summary, record.document);
        set((state) => ({
            projects: [project, ...state.projects.filter((item) => item.id !== id)],
            canvases: upsertSummary(state.canvases, record.summary),
        }));
        return project;
    },

    // The empty document travels with the create, so a canvas never exists in a state where opening it
    // and reading it disagree. A failure is thrown: the caller is a dialog with a toast, and a canvas
    // that silently did not get created is worse than an error message.
    createCanvas: async (title = i18n.t("canvas.project.untitled")) => {
        const record = await requestCanvasCreate(title, emptyCanvasDocument());
        const project = projectOf(record.summary, record.document);
        set((state) => ({ canvases: upsertSummary(state.canvases, record.summary), projects: [project, ...state.projects] }));
        return record.summary.id;
    },

    // An import is a create whose document came from a zip. The id is new, always: the exported id is
    // the id of the canvas it was exported from, which still exists.
    importCanvas: async (source) => {
        const document: CanvasDocument = { ...emptyCanvasDocument(), ...source };
        const record = await requestCanvasCreate(source.title || i18n.t("canvas.project.imported"), document);
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
