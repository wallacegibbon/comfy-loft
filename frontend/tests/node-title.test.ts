import { describe, expect, it } from "vitest";

import i18n from "@/i18n";
import { mentionLabel, nodeTitle } from "@/lib/canvas/node-title";
import { channelName, normalizeChannelModels } from "@/stores/use-config-store";

/**
 * Node titles follow the language of the reader, not the language of the session that created them.
 *
 * A canvas is saved data. Storing a translated title meant a canvas made in Chinese said "图片" in the
 * English UI forever; storing the key means the same canvas reads correctly in both.
 */
const zh = (key: string, options?: Record<string, unknown>) => i18n.t(key, { ...options, lng: "zh-CN" });
const en = (key: string, options?: Record<string, unknown>) => i18n.t(key, { ...options, lng: "en-US" });

describe("nodeTitle", () => {
    it("renders the key when there is one", () => {
        const node = { title: "图片", titleKey: "canvas.nodeTypes.image" };
        expect(nodeTitle(node, zh)).toBe("图片");
        expect(nodeTitle(node, en)).toBe("Image");
    });

    it("passes the params through, so a template title stays a template", () => {
        const node = { title: "a.png 1-1", titleKey: "canvas.runtime.splitTitle", titleParams: { name: "a.png", row: 1, column: 1 } };
        expect(nodeTitle(node, en)).toBe("a.png 1-1");
    });

    it("falls back to the stored title, which is what a user-typed name is", () => {
        expect(nodeTitle({ title: "My hero shot" }, en)).toBe("My hero shot");
    });

    it("is empty when the node has neither, so the caller can substitute its own word", () => {
        expect(nodeTitle({}, en)).toBe("");
    });
});

describe("channelName", () => {
    it("follows the language while the name is still the default", () => {
        expect(channelName({ name: "本地 ComfyUI", nameKey: "config.channels.localName" })).toBe(i18n.t("config.channels.localName"));
        expect(channelName({ name: "Local ComfyUI", nameKey: "config.channels.localName" })).toBe(i18n.t("config.channels.localName"));
    });

    it("shows a name the user typed as typed", () => {
        expect(channelName({ name: "My rig" })).toBe("My rig");
    });
});

describe("normalizeChannelModels", () => {
    it("keeps the capability a stored model had", () => {
        expect(normalizeChannelModels([{ name: "audio-minimax-music-3", capability: "audio" }])[0].capability).toBe("audio");
    });
});

/**
 * What a mention calls a node.
 *
 * A title is not an address: every picture is created as "Image" (or 图片), so ten of them are ten `@Image`s and
 * the reader picking one has nothing to go on. The id names exactly one node, and it is what every tool answers
 * with — so a node the user has not named is mentioned by its id, and one they have named keeps their words.
 */
describe("mentionLabel", () => {
    it("is the id when the node only has the default title of its type", () => {
        expect(mentionLabel({ id: "image-1793960998462-zngu6", title: "图片", titleKey: "canvas.nodeTypes.image" })).toBe("image-1793960998462-zngu6");
    });

    it("is the name the user gave it, which is the one thing that reads like a name", () => {
        expect(mentionLabel({ id: "image-1", title: "hero shot" })).toBe("hero shot");
    });

    it("falls back to the id for a node with no title at all", () => {
        expect(mentionLabel({ id: "image-1" })).toBe("image-1");
    });
});
