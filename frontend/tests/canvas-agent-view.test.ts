import { describe, expect, test } from "vitest";

import { describeCanvas } from "../src/lib/canvas/canvas-agent-view";
import type { CanvasConnection, CanvasNodeData, CanvasNodeMetadata, CanvasTrashEntry } from "../src/types/canvas";

/**
 * What `list_nodes` answers with.
 *
 * One line per node, carrying what the node *holds* — `content:` — and nothing else. What a node will be
 * asked is a private word until someone reads it on purpose, which `read_prompt` is for: a list that
 * printed both carried every node's words twice, and put a field with two meanings back where #229 had
 * just cleaned it up (#233).
 */

function node(type: CanvasNodeData["type"], metadata: CanvasNodeMetadata = {}): CanvasNodeData {
    return { id: `${type}-1`, type, position: { x: 40, y: -12 }, width: 320, height: 240, metadata };
}

const canvas = (nodes: CanvasNodeData[], connections: CanvasConnection[] = []) => describeCanvas(nodes, connections).split("\n");

describe("the canvas as the agent reads it", () => {
    test("a node says whether anything is happening in it, so a press with no answer can be checked", () => {
        // A press that got no answer from the page leaves one question: did a run take hold? The node is where
        // that is answered, and it used to say nothing about it (#285).
        const lines = canvas([node("image", { status: "loading" }), node("image", { status: "error", errorDetails: "cannot reach ComfyUI" }), node("image", {})]);
        expect(lines[1]).toContain("[generating now]");
        expect(lines[2]).toContain("[last run failed: cannot reach ComfyUI]");
        // An idle node says nothing: a line of "idle" on every node of a big canvas is noise.
        expect(lines[3]).not.toContain("generating");
        expect(lines[3]).not.toContain("failed");
    });

    test("a text node shows the text it says, and not the question standing behind it", () => {
        const lines = canvas([node("text", { content: "宫崎骏风格的森林。", composerContent: "改成无字幕的版本" })]);
        expect(lines[0]).toBe("1 nodes, 0 connections");
        // No name on the line: a node has none, and the type is already there beside the id (#321).
        expect(lines[1]).toBe(`- text-1 (text) at (40, -12), 320×240 content: 宫崎骏风格的森林。`);
        // The question is still there, one call away: `read_prompt` is what answers with it (#233).
        expect(describeCanvas([node("text", { composerContent: "改成无字幕的版本" })], [])).not.toContain("改成无字幕的版本");
    });

    test("a picture shows the run that made it, and no content words of its own", () => {
        // Its content is the picture, which a line cannot carry: the type says what it is, `read_node`
        // hands the bytes over, and the file's URL — which used to fall through as "words" — is not text.
        const lines = canvas([node("image", { content: "/api/canvases/c/files/a.png", prompt: "a brass compass", workflow: "image-z-image-turbo", generatedAt: "2026-11-03T13:09:19.928Z" })]);
        expect(lines[1]).toBe("- image-1 (image) at (40, -12), 320×240 made 2026-11-03T13:09:19.928Z with image-z-image-turbo");
    });

    test("a node with no words at all is still a line, because an empty node is a fact too", () => {
        expect(canvas([node("image", { content: "/api/canvases/c/files/a.png" })])[1]).toBe("- image-1 (image) at (40, -12), 320×240");
    });

    test("a node's words stay on its own line, however many paragraphs they were", () => {
        const lines = canvas([node("text", { content: "line one\nline two\n\nline three" }), node("image", { prompt: "second node" })]);
        expect(lines).toHaveLength(3);
        expect(lines[1]).toContain("content: line one line two line three");
        expect(lines[2]).toContain("image-1");
    });

    test("the connections are listed after the nodes, in the order they exist", () => {
        const lines = canvas([node("text", { content: "a brass compass" }), node("image", { prompt: "a compass on a table" })], [{ id: "c1", fromNodeId: "text-1", toNodeId: "image-1" }]);
        expect(lines).toEqual(["2 nodes, 1 connections", "- text-1 (text) at (40, -12), 320×240 content: a brass compass", "- image-1 (image) at (40, -12), 320×240", "connections:", "- text-1 -> image-1"]);
    });

    // A group is the one relation a flat list cannot show by accident: the card is drawn around members that
    // are ordinary nodes, so without a clause the list named a box and said nothing about what was in it.
    // It is stated from both ends, because both questions are asked — "what is in g1" and "where does this
    // node belong" — and each is answered by reading one line.
    test("a group names its members, and a member names its group", () => {
        const group = { ...node("group"), id: "g1", title: "森林" };
        const inside = [
            { ...node("image", { content: "/api/canvases/c/files/a.png" }), id: "n1", metadata: { content: "/api/canvases/c/files/a.png", groupId: "g1" } },
            { ...node("text", { content: "无字幕" }), id: "n2", metadata: { content: "无字幕", groupId: "g1" } },
        ];
        const lines = canvas([group, ...inside]);
        expect(lines[1]).toBe(`- g1 (group) at (40, -12), 320×240 members: n1, n2`);
        expect(lines[2]).toBe("- n1 (image) at (40, -12), 320×240 in group g1");
        expect(lines[3]).toBe("- n2 (text) at (40, -12), 320×240 in group g1 content: 无字幕");
    });

    test("a group nobody is in says so, rather than looking like a group whose members were left out", () => {
        // The two are different: "members: none" is a card to fill, and a missing clause would have been a
        // group this format simply did not understand.
        expect(canvas([{ ...node("group"), id: "g1" }])[1]).toBe("- g1 (group) at (40, -12), 320×240 members: none");
    });

    // A card is the shape of what it holds, not its size: an agent deciding whether a node is worth reading
    // needs to know the photograph is 1920×1280 in a 480×320 card. The second size is left out when the two
    // agree, because a fact repeated is noise.
    test("a picture's own size is on the line when the card is not that size", () => {
        const picture = (naturalWidth: number, naturalHeight: number) => ({ ...node("image", { content: "/api/canvases/c/files/a.png", naturalWidth, naturalHeight }) });
        expect(canvas([picture(1920, 1280)])[1]).toBe("- image-1 (image) at (40, -12), 320×240 (picture 1920×1280)");
        // The card IS the picture here (320×240), so there is one size to state and it has been stated.
        expect(canvas([picture(320, 240)])[1]).toBe("- image-1 (image) at (40, -12), 320×240");
    });

    // A film's length is the one content fact a card never shows, and it is what a chain of clips is planned
    // from: "how long is this, and how many more make a minute". Unlike the pixels it is never left out —
    // there is nothing on the card it could be repeating.
    test("a clip's length is on its line, and so is a sound's", () => {
        const film = { ...node("video", { content: "/api/canvases/c/files/a.mp4", naturalWidth: 1280, naturalHeight: 720, durationMs: 12400 }) };
        expect(canvas([film])[1]).toBe("- video-1 (video) at (40, -12), 320×240 (picture 1280×720, 12.4 s)");
        const sound = { ...node("audio", { content: "/api/canvases/c/files/a.mp3", durationMs: 3000 }) };
        expect(canvas([sound])[1]).toBe("- audio-1 (audio) at (40, -12), 320×240 (3.0 s)");
    });
});

/**
 * What the canvas threw away, on the same list (#327).
 *
 * A deletion leaves nothing on the board, so this is the only place a reader learns that a node it remembers
 * is recoverable rather than gone — and it is what `restore_node` takes its ids from. The lines are shaped
 * like a live node's because they identify the same kind of thing, minus the geometry a deleted node has not.
 */
describe("the trash on the list", () => {
    const deleted = (overrides: Partial<CanvasNodeData>, deletedAt = new Date(Date.now() - 5 * 60_000).toISOString()): CanvasTrashEntry => ({
        deletedAt,
        node: { id: "image-9", type: "image", position: { x: 0, y: 0 }, width: 320, height: 240, ...overrides } as CanvasNodeData,
        connections: [],
    });

    test("the count is in the header and one line says what each one was", () => {
        const lines = describeCanvas([], [], [deleted({ metadata: { naturalWidth: 1024, naturalHeight: 1024 } })]).split("\n");
        expect(lines[0]).toBe("0 nodes, 0 connections, 1 in the trash");
        expect(lines[1]).toBe("trash:");
        expect(lines[2]).toBe("- image-9 (image) (picture 1024×1024) deleted 5 minutes ago");
    });

    test("a deleted text node carries its words, because that is what identifies it", () => {
        const lines = describeCanvas([], [], [deleted({ id: "text-1", type: "text", metadata: { content: "宫崎骏风格的森林。" } })]).split("\n");
        expect(lines[2]).toBe("- text-1 (text) deleted 5 minutes ago content: 宫崎骏风格的森林。");
    });

    test("an empty trash is not a section", () => {
        expect(describeCanvas([], [], [])).toBe("0 nodes, 0 connections");
    });

    test("a deletion with no readable timestamp is still a line, without the date", () => {
        // A hand-written or damaged document can hold `deletedAt: ""`. The node is what matters; the date is
        // the half a reader can do without.
        const lines = describeCanvas([], [], [deleted({}, "")]).split("\n");
        expect(lines[2]).toBe("- image-9 (image)");
    });

    test("time is said in the unit a reader can order without a clock", () => {
        // Read through the line rather than through the helper: what a reader gets is the sentence, and
        // `sinceWords` has no caller but that line.
        const lineFor = (secondsAgo: number) => describeCanvas([], [], [deleted({}, new Date(Date.now() - secondsAgo * 1000).toISOString())]).split("\n")[2];
        expect(lineFor(20)).toBe("- image-9 (image) deleted just now");
        expect(lineFor(60)).toBe("- image-9 (image) deleted 1 minute ago");
        expect(lineFor(3 * 3600)).toBe("- image-9 (image) deleted 3 hours ago");
        expect(lineFor(26 * 3600)).toBe("- image-9 (image) deleted 1 day ago");
        // A clock that went backwards is not "in -1 minute": it is the present.
        expect(lineFor(-60)).toBe("- image-9 (image) deleted just now");
    });
});
