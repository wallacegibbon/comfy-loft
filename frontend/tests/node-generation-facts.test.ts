import { describe, expect, test } from "vitest";

import { configuredClause, generationClause } from "../src/lib/canvas/node-generation-facts";

/**
 * What a tool says about how a node's content was made.
 *
 * `list_nodes` and `read_node` both print this clause, and the agent's answer to "which model drew this,
 * and when" is only as good as the sentence they print. The stamp is the server's own instant, printed
 * as recorded: a locale would make the same fact read differently for the model and for the user (#227).
 */
/**
 * What a node is set to run, as the one clause `read_prompt` adds to the words.
 *
 * The maker clause answers a question about the past; this one answers the question a rewrite depends on,
 * because H3's skill picks its section order from the input mode and the run is where that mode lives
 * (#257). The picker value is the user's, so the channel prefix goes and the tail stays.
 */
describe("configuredClause", () => {
    test("names the workflow the next run will ask, and the length it will ask for", () => {
        expect(configuredClause({ model: "default::video-h3-frames", seconds: "4" })).toBe("set to run video-h3-frames, 4 s");
    });

    test("names the workflow alone when the node keeps no duration of its own", () => {
        // The global default is not a fact about this node: saying "5 s" because the settings say 5 s
        // would be the tool answering for a run it was not asked about.
        expect(configuredClause({ model: "default::image-qwen21" })).toBe("set to run image-qwen21");
    });

    test("keeps a bare model name, which is what an unpicked channel writes", () => {
        expect(configuredClause({ model: "video-h3-t2v" })).toBe("set to run video-h3-t2v");
    });

    test("says nothing for a node that was never given one", () => {
        // A text node's model belongs to its agent, not to a workflow; a node made before the picker was
        // written has no picker at all. Either way there is no run to describe.
        expect(configuredClause({ prompt: "a cat" })).toBe("");
        expect(configuredClause(undefined)).toBe("");
        expect(configuredClause({ model: "  " })).toBe("");
    });
});

describe("generationClause", () => {
    test("names the workflow and the moment it finished", () => {
        expect(generationClause({ workflow: "image-z-image-turbo", generatedAt: "2026-11-03T13:09:19.928Z" })).toBe("made 2026-11-03T13:09:19.928Z with image-z-image-turbo");
    });

    test("names the workflow alone when there is no stamp to trust", () => {
        expect(generationClause({ workflow: "image-z-image-turbo" })).toBe("made with image-z-image-turbo");
    });

    test("names the moment alone", () => {
        expect(generationClause({ generatedAt: "2026-11-03T13:09:19.928Z" })).toBe("made 2026-11-03T13:09:19.928Z");
    });

    test("says nothing for a node nothing made", () => {
        // A node the user drew on, or one built before the fact was recorded: the tool says nothing rather
        // than "made with unknown", which reads like an answer.
        expect(generationClause({ prompt: "a cat" })).toBe("");
        expect(generationClause(undefined)).toBe("");
        expect(generationClause({ workflow: "  ", generatedAt: "" })).toBe("");
    });
});
