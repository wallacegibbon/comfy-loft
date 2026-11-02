/**
 * The IndexedDB databases this app owns, and the object stores inside the main one.
 *
 * This name used to be a string literal in four files — `localforage.config` in one place,
 * `createInstance` in three services, and again in the storage-usage reader. Nothing made them
 * agree, and they did not: the reader knew about some of what was stored and not the rest, so the
 * panel under-reported what the browser held against the quota.
 *
 * There is one database. A second one existed for plugin storage; the plugin mechanism is gone
 * (docs/decisions.md #148), and its database is left on disk unread, like the pre-#147 keys.
 */

/** The database: canvas state, uploaded media, generated images and the logs for both. */
export const APP_DATABASE = "comfyloft";

/**
 * The object stores in {@link APP_DATABASE}, for anyone who needs the list rather than a single
 * name: `app_state` (canvas state), `media_files`, `image_files`, `image_previews`, and
 * the `image_generation_logs` / `video_generation_logs` history.
 */
