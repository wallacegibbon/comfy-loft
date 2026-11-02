import { saveAs } from "file-saver";

import { localForageStorage } from "@/lib/localforage-storage";
import { createZip } from "@/lib/zip";
import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob } from "@/services/image-storage";

/**
 * The asset library #144 deleted, as it still sits in the browser.
 *
 * The store is gone from the code, so nothing reads `comfy-loft:asset_store` any more — but the key
 * is still in IndexedDB on any machine that used the library, and the blobs its records point at are
 * still the only copy of whatever someone saved there and nowhere else. Deleting the code without a
 * way out would have turned a feature removal into silent data loss, so this module exists to be
 * deleted later: read the record back, hand the user a zip, and only then let the sweep collect.
 *
 * Deliberately not a migration. Nothing is converted into a canvas, nothing imports these records
 * back into anything: the package is the old library's own shape (`assets.json` verbatim + `files/`),
 * because a format nothing reads is safer than a format only this one-time path writes.
 *
 * There is one case worth naming, because it is the common one: a machine that had the app open but
 * never saved anything still has an empty envelope — `{"state":{"assets":[]},"version":1}`. That is
 * not a decision for the user to make, so `empty` says so and the banner quietly deletes it.
 */

const LEGACY_ASSET_STORE_KEY = "comfy-loft:asset_store";

/** One record, loose on purpose: the point is to carry it out, not to understand it. */
type LegacyAsset = {
    id: string;
    kind: string;
    title?: string;
    data: Record<string, unknown>;
};

export type LegacyAssetLibrary = {
    /** The stored bytes, exactly as they were written. Shipped verbatim in the package. */
    raw: string;
    assets: LegacyAsset[];
    /** The store parsed cleanly and held no records at all: nothing to rescue, nothing to ask. */
    empty: boolean;
};

/**
 * What a stored blob holds: the records this build can use, and whether there were none to begin with.
 *
 * Zustand's envelope is `{ version, state: { assets } }`; the versionless shape it wrote eight
 * releases ago is `{ state: { assets } }` too, and a hand-edited file can be `{ assets }`. None of
 * that matters much: a record is kept when it has an id, a kind and a non-empty `data`, because those
 * are the three fields the export uses. Anything else would only be copied by rote.
 *
 * A blob that does not parse is *not* empty — it is unreadable, and its bytes are still the user's.
 */
export function readLegacyLibrary(raw: string): LegacyAssetLibrary {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { raw, assets: [], empty: false };
    }
    const root = asRecord(parsed);
    if (!root) return { raw, assets: [], empty: false };
    const state = asRecord(root.state) ?? root;
    const records = state.assets;
    if (!Array.isArray(records)) return { raw, assets: [], empty: false };

    const assets: LegacyAsset[] = [];
    for (const entry of records) {
        const asset = asRecord(entry);
        if (!asset) continue;
        const data = asRecord(asset.data);
        if (typeof asset.id !== "string" || !asset.id) continue;
        if (typeof asset.kind !== "string" || !data || !Object.keys(data).length) continue;
        assets.push({ id: asset.id, kind: asset.kind, title: typeof asset.title === "string" ? asset.title : undefined, data });
    }
    return { raw, assets, empty: records.length === 0 };
}

/** The stored files this library needs alive, so the sweep can treat them as a root. */
export function legacyAssetFileKeys(assets: LegacyAsset[]) {
    const keys = new Set<string>();
    for (const asset of assets) {
        const key = asset.data.storageKey;
        if (typeof key === "string" && key.includes(":")) keys.add(key);
    }
    return [...keys];
}

export async function loadLegacyAssetLibrary(): Promise<LegacyAssetLibrary | null> {
    if (typeof window === "undefined") return null;
    const raw = await localForageStorage.getItem(LEGACY_ASSET_STORE_KEY);
    if (!raw) return null;
    return readLegacyLibrary(raw);
}

/**
 * The package, in memory: `assets.json` verbatim, a note, and every file the records still have.
 *
 * `assets.json` is the stored bytes, not a re-serialisation: if this build's reading of some record
 * is wrong, the user still has exactly what the library wrote. A record whose blob is already gone
 * is skipped rather than written as an empty file — the count that comes back is the truth about
 * what the package holds.
 *
 * Takes the blob reader as an argument so the package can be tested without a browser: the two
 * IndexedDB stores it reads from are the only untestable part of this module.
 */
export async function buildLegacyAssetPackage(library: LegacyAssetLibrary, readBlob = storedBlob) {
    const files: { name: string; data: BlobPart }[] = [];
    for (const [index, asset] of library.assets.entries()) {
        const storageKey = asset.data.storageKey;
        if (typeof storageKey !== "string" || !storageKey.includes(":")) continue;
        const blob = await readBlob(storageKey);
        if (!blob) continue;
        files.push({ name: `files/${index + 1}-${safeName(asset.title || asset.id)}.${fileExtension(blob.type, asset.kind)}`, data: blob });
    }
    const blob = await createZip([{ name: "assets.json", data: library.raw }, { name: "README.txt", data: README }, ...files]);
    return { blob, files: files.length };
}

/** Write the package to a zip the user picks a home for; returns how many files it holds. */
export async function exportLegacyAssetLibrary(library: LegacyAssetLibrary) {
    const { blob, files } = await buildLegacyAssetPackage(library);
    saveAs(blob, `asset-library-${new Date().toISOString().slice(0, 10)}.zip`);
    return files;
}

function storedBlob(storageKey: string) {
    return storageKey.startsWith("image:") ? getImageBlob(storageKey) : getMediaBlob(storageKey);
}

export async function discardLegacyAssetLibrary() {
    await localForageStorage.removeItem(LEGACY_ASSET_STORE_KEY);
}

const README = `This is the asset library that Comfy Loft removed (docs/decisions.md #144).

assets.json  The library's records, exactly as the browser had them.
files/       The media those records pointed at, in the same order as the records.

Nothing in the app reads this package. It is here so that whatever you saved to the library and
nowhere else can still be used: drag the files into a canvas, or keep them wherever you keep
images. Text records are in assets.json ("data.content").
`;

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function safeName(value: string) {
    return (
        value
            .replace(/[\\/:*?"<>|\s]+/g, "-")
            .slice(0, 40)
            .replace(/^-|-$/g, "") || "asset"
    );
}

function fileExtension(mimeType: string, kind: string) {
    if (mimeType.includes("png")) return "png";
    if (mimeType.includes("jpeg")) return "jpg";
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("gif")) return "gif";
    if (mimeType.includes("mp4")) return "mp4";
    if (mimeType.includes("webm")) return "webm";
    if (mimeType.includes("audio")) return "mp3";
    return kind === "image" ? "png" : "bin";
}
