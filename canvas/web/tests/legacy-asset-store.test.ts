import { describe, expect, it } from "vitest";

import { buildLegacyAssetPackage, legacyAssetFileKeys, readLegacyLibrary } from "@/lib/canvas/legacy-asset-store";
import { readZip } from "@/lib/zip";

/**
 * The one-time exit for the asset library `docs/decisions.md` #144 deleted.
 *
 * Everything here is about not throwing: this reads a blob written by a store that no longer exists,
 * on a path that runs at boot, and a parse error there would be a blank app rather than a message.
 * The records that survive are the ones the export can use — an id, a kind and something in `data`.
 */

const image = (overrides: Record<string, unknown> = {}) => ({
    id: "A1",
    kind: "image",
    title: "Hero shot",
    coverUrl: "",
    tags: [],
    data: { dataUrl: "blob:x", storageKey: "image:abc", width: 1, height: 1, bytes: 1, mimeType: "image/png" },
    ...overrides,
});

describe("the asset library left behind", () => {
    it("reads the state envelope the store wrote", () => {
        const raw = JSON.stringify({ version: 1, state: { assets: [image()] } });
        expect(readLegacyLibrary(raw).assets).toHaveLength(1);
        expect(readLegacyLibrary(raw).assets[0].id).toBe("A1");
    });

    it("reads the versionless envelope as well", () => {
        const raw = JSON.stringify({ state: { assets: [image()] } });
        expect(readLegacyLibrary(raw).assets).toHaveLength(1);
    });

    it("reads a bare assets array, which is what a hand-edited file looks like", () => {
        const raw = JSON.stringify({ assets: [image()] });
        expect(readLegacyLibrary(raw).assets).toHaveLength(1);
    });

    it("answers an empty list for anything it cannot parse instead of throwing", () => {
        expect(readLegacyLibrary("{oops truncated").assets).toEqual([]);
        expect(readLegacyLibrary("null").assets).toEqual([]);
        expect(readLegacyLibrary(JSON.stringify({ state: { assets: "nope" } })).assets).toEqual([]);
        expect(readLegacyLibrary(JSON.stringify({ state: { assets: [1, null, "x"] } })).assets).toEqual([]);
    });

    it("calls an envelope with no records empty, so nobody is asked about it", () => {
        expect(readLegacyLibrary(JSON.stringify({ state: { assets: [] }, version: 1 })).empty).toBe(true);
        expect(readLegacyLibrary(JSON.stringify({ state: { assets: [image()] } })).empty).toBe(false);
    });

    it("does not call an unreadable blob empty, because its bytes are still the user's", () => {
        expect(readLegacyLibrary("{oops truncated").empty).toBe(false);
        expect(readLegacyLibrary(JSON.stringify({ state: { assets: "nope" } })).empty).toBe(false);
    });

    it("keeps the raw bytes it was given, unchanged", () => {
        const raw = '{"state":{"assets":[{"id":"A1","kind":"image","data":{"storageKey":"image:abc"}}]},"version":1}';
        expect(readLegacyLibrary(raw).raw).toBe(raw);
    });

    it("drops records the export could not use", () => {
        const raw = JSON.stringify({
            state: { assets: [image(), { id: "", kind: "image", data: { storageKey: "image:x" } }, { id: "A3", kind: "image" }, { id: "A4", kind: "image", data: {} }] },
        });
        expect(readLegacyLibrary(raw).assets.map((asset) => asset.id)).toEqual(["A1"]);
    });

    it("keeps a text record, which has content but no file", () => {
        const raw = JSON.stringify({ state: { assets: [{ id: "T1", kind: "text", data: { content: "a style block" } }] } });
        const assets = readLegacyLibrary(raw).assets;
        expect(assets).toHaveLength(1);
        expect(legacyAssetFileKeys(assets)).toEqual([]);
    });

    it("names the files the sweep must keep alive", () => {
        const raw = JSON.stringify({
            state: { assets: [image(), image({ id: "A2", kind: "video", data: { storageKey: "video:def" } }), { id: "A3", kind: "text", data: { content: "x" } }] },
        });
        expect(legacyAssetFileKeys(readLegacyLibrary(raw).assets)).toEqual(["image:abc", "video:def"]);
    });
});

describe("the package the one-time exit writes", () => {
    const records = (assets: unknown[]) => JSON.stringify({ version: 1, state: { assets } });

    it("ships the stored bytes verbatim, so a wrong reading cannot lose anything", async () => {
        const raw = records([image()]);
        const { blob } = await buildLegacyAssetPackage(readLegacyLibrary(raw), async () => null);
        const zip = await readZip(blob);
        expect(await zip.get("assets.json")!.text()).toBe(raw);
        expect(await zip.get("README.txt")!.text()).toContain("decisions.md #144");
    });

    it("names each file after its record and keeps the media type's extension", async () => {
        const raw = records([image(), image({ id: "A2", kind: "video", title: "Clip", data: { storageKey: "video:def", mimeType: "video/mp4" } })]);
        const { blob, files } = await buildLegacyAssetPackage(readLegacyLibrary(raw), async (key) => new Blob(["x"], { type: key.startsWith("image:") ? "image/png" : "video/mp4" }));
        const zip = await readZip(blob);
        expect(files).toBe(2);
        expect([...zip.keys()].sort()).toEqual(["README.txt", "assets.json", "files/1-Hero-shot.png", "files/2-Clip.mp4"]);
    });

    it("skips a record whose blob is already gone instead of writing an empty file", async () => {
        const raw = records([image(), image({ id: "A2", data: { storageKey: "image:gone" } })]);
        const { blob, files } = await buildLegacyAssetPackage(readLegacyLibrary(raw), async (key) => (key === "image:abc" ? new Blob(["x"], { type: "image/png" }) : null));
        expect(files).toBe(1);
        const zip = await readZip(blob);
        expect([...zip.keys()].filter((name) => name.startsWith("files/"))).toEqual(["files/1-Hero-shot.png"]);
    });

    it("writes a package with no files for a library of text, which is a real answer", async () => {
        const raw = records([{ id: "T1", kind: "text", title: "Style", data: { content: "cinematic" } }]);
        const { files } = await buildLegacyAssetPackage(readLegacyLibrary(raw), async () => new Blob([]));
        expect(files).toBe(0);
    });
});
