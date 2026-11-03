import { describe, expect, it } from "vitest";

import { generateAnswer, GENERATE_START_WAIT_MS, type GenerateStart } from "@/lib/canvas/agent-generate";

/**
 * What `generate` tells the agent, which is the tool's whole contract with the model.
 *
 * A press either put a run out — so a message will come when it ends, and waiting or polling is wrong —
 * or it did not, and the agent has to be told that and why, because "nothing was started" and "it is
 * running" send it in opposite directions (#225).
 */
describe("the answer to generate", () => {
    it("says a run is out, and that the message comes later", () => {
        const answer = generateAnswer("n12", "image", { started: true, runId: "task_6f2c" });

        expect(answer).toContain("pressed generate on n12 (image)");
        expect(answer).toContain("task_6f2c");
        expect(answer).toContain("you will be sent a message when it finishes");
        expect(answer).toContain("do not wait for it or poll");
        // Nothing in it says the run failed: that word belongs to the refusal.
        expect(answer).not.toContain("did not start");
    });

    it("says nothing was started, with the page's own reason", () => {
        const answer = generateAnswer("n12", "video", { started: false, reason: "no model is set for video generation on this canvas" });

        expect(answer).toContain("did not start");
        expect(answer).toContain("no model is set for video generation on this canvas");
        // And that there is nothing coming, so it does not wait for a message that will never arrive.
        expect(answer).toContain("nothing to wait for");
        expect(answer).not.toContain("you will be sent a message");
    });

    it("neither claims nor denies a run it never heard about", () => {
        const answer = generateAnswer("n12", "image", undefined);

        expect(answer).toContain("no run was reported within");
        expect(answer).toContain(String(Math.round(GENERATE_START_WAIT_MS / 1000)));
        // Both outcomes are named, because at that moment neither is known.
        expect(answer).toContain("If it starts");
        expect(answer).toContain("if it does not");
    });

    it("is a refusal only for a refusal, which is what makes the tool call fail", () => {
        const answered: GenerateStart = { started: false, reason: "the node has no prompt to generate from" };
        expect(answered.started).toBe(false);
        // The hook sets `isError` from exactly this flag; the sentence and the flag cannot disagree because
        // both come from the same word about whether a run exists.
        expect(generateAnswer("n1", "audio", answered)).toContain("the node has no prompt to generate from");
    });
});
