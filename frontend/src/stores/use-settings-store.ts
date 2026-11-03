import { create } from "zustand";

import { RUNTIME_SETTINGS } from "@/constant/runtime-config";
import { requestSettings, requestSettingsSave, type SettingsBlob } from "@/services/api/settings";

/**
 * The workspace preferences: one document on the server, one copy in memory.
 *
 * It used to be five `localStorage` keys and an IndexedDB database, which meant the preferences of a
 * workspace belonged to one browser on one machine — the phone on the LAN opened an English, light,
 * empty workbench next to a Chinese, dark one with the same canvases. The keys now live in
 * `data/settings.json` (#155): they survive a cleared browser and travel with the workspace, and the
 * canvas carries no persisted state at all.
 *
 * **Why there is no request at startup.** The page loads a script before its bundle (`/config.js`), and the
 * server answers it with this document (`internal/server/runtime_config.go`, #220), so it is available
 * synchronously, before the first frame. Without it the theme would arrive one paint late.
 * `load()` is therefore the fallback, not the path: it asks over HTTP only when the bootstrap is
 * missing, and until one of the two has produced a document the store refuses to save — writing
 * defaults over a document this build never read is the one failure worth a guard.
 *
 * **Writes are whole-document and debounced.** The server replaces the file; there is no per-key
 * merge on either side. The debounce is what keeps a dragged panel width from being one request per
 * pixel.
 */

type SettingsStore = {
    settings: SettingsBlob;
    /** Something has been read — from the bootstrap file or over HTTP — so saving is safe. */
    ready: boolean;
    /** The last save failure, for whoever wants to show it. */
    error: string | null;
    load: () => Promise<void>;
    patch: (key: string, value: unknown) => void;
    flush: () => void;
};

const bootstrapped: SettingsBlob = RUNTIME_SETTINGS;
const SAVE_DEBOUNCE_MS = 600;

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pending = false;
/** The write that is on the wire, if any: one document at a time, so two saves cannot land out of order. */
let saving: Promise<void> | null = null;

export const useSettingsStore = create<SettingsStore>()((set, get) => ({
    settings: bootstrapped,
    ready: Object.keys(bootstrapped).length > 0,
    error: null,

    load: async () => {
        if (get().ready) return;
        try {
            const settings = await requestSettings();
            set({ settings, ready: true, error: null });
        } catch (error) {
            // Leave `ready` false: without a document of record, a save would replace the server's
            // preferences with this build's defaults.
            set({ error: error instanceof Error ? error.message : String(error) });
        }
    },

    patch: (key, value) => {
        if (!get().ready) return;
        set({ settings: { ...get().settings, [key]: value } });
        pending = true;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveTimer = null;
            void save();
        }, SAVE_DEBOUNCE_MS);
    },

    // The page is going away: ask for the write to survive the navigation, not just to start.
    flush: () => {
        if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = null;
        }
        void save(true);
    },
}));

/**
 * Write the pending document, one request at a time.
 *
 * Serialised on purpose: the server replaces the whole file, so two requests in flight at once could
 * land out of order and leave the older document as the one on disk. A change that arrives while a
 * request is on the wire is written by the next one; a failure is left for the next change (or `flush`)
 * to retry rather than looped on here.
 */
function save(keepalive = false): void {
    if (saving || !pending) return;
    const state = useSettingsStore.getState();
    if (!state.ready) return;
    pending = false;
    const document = state.settings;
    saving = (async () => {
        let written = true;
        try {
            await requestSettingsSave(document, { keepalive });
            useSettingsStore.setState({ error: null });
        } catch (error) {
            // Keep the change in memory and try again with the next one: preferences are cheap to lose, but
            // silently losing every future change because one request failed would not be.
            written = false;
            pending = true;
            useSettingsStore.setState({ error: error instanceof Error ? error.message : String(error) });
        } finally {
            saving = null;
        }
        if (written && pending) save();
    })();
}

/**
 * One preference, read synchronously.
 *
 * Every caller uses this at module or component mount, where waiting is not an option: the theme store
 * has to know its theme before the first render, and the side panel has to know its width before it
 * draws. `fallback` covers a workspace that has never saved this key.
 */
export function readSetting<T>(key: string, fallback: T): T {
    const value = useSettingsStore.getState().settings[key];
    return value === undefined || value === null ? fallback : (value as T);
}

/** One preference, written. Same debounce as `patch`, and a no-op until something has been read. */
export function writeSetting(key: string, value: unknown) {
    useSettingsStore.getState().patch(key, value);
}

/**
 * Persist a store that already keeps its own state, by publishing its persisted slice on every change.
 *
 * The alternative was a `writeSetting` call in every setter of every store — twenty edits, each one a
 * place to forget. One subscription per store is one line, and it cannot drift from the state it
 * copies because it reads that state.
 */
export function mirrorToSettings<T>(store: { subscribe: (listener: (state: T) => void) => () => void; getState: () => T }, key: string, select: (state: T) => unknown) {
    let previous = JSON.stringify(select(store.getState()));
    store.subscribe((state) => {
        const next = JSON.stringify(select(state));
        if (next === previous) return;
        previous = next;
        writeSetting(key, JSON.parse(next) as unknown);
    });
}
