import { describe, expect, test } from "vitest";

import { generationClause } from "../src/lib/canvas/node-generation-facts";

/**
 * What a tool says about how a node's content was made.
 *
 * `list_nodes` and `read_node` both print this clause, and the agent's answer to "which model drew this,
 * and when" is only as good as the sentence they print. The stamp is the gateway's own instant, printed
 * as recorded: a locale would make the same fact read differently for the model and for the user (#227).
 */
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
