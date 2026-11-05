import { describe, expect, it } from "vitest";

import { generateAnswer, type GenerateStart } from "@/lib/canvas/agent-generate";

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

    it("is never a promise about a run that has not been reported", () => {
        // Two answers, and both are facts: a run is out, or nothing started and here is why. There used to be a
        // third for "no news yet" which promised a message either way, and keeping that promise needed a keeper,
        // a late message and a ledger (#285). A press now answers when the page answers; a page that never
        // answers is answered by the bridge, and the agent reads the node to see whether a run took hold.
        const refused: GenerateStart = { started: false, reason: "workflow image-z-image-turbo requires a non-empty prompt" };
        expect(generateAnswer("n1", "image", refused)).toContain("Nothing was queued");
        expect(generateAnswer("n1", "image", refused)).not.toContain("will be sent");
        const started: GenerateStart = { started: true, runId: "task_1" };
        expect(generateAnswer("n1", "image", started)).toContain("you will be sent a message");
    });

    it("is a refusal only for a refusal, which is what makes the tool call fail", () => {
        const answered: GenerateStart = { started: false, reason: "the node has no prompt to generate from" };
        expect(answered.started).toBe(false);
        // The hook sets `isError` from exactly this flag; the sentence and the flag cannot disagree because
        // both come from the same word about whether a run exists.
        expect(generateAnswer("n1", "audio", answered)).toContain("the node has no prompt to generate from");
    });
});
