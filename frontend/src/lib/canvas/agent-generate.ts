/**
 * What pressing a node's generate button turned out to be, and what the agent is told about it.
 *
 * `generate` answers at once — a picture takes minutes, and a tool call is not a progress bar — so the
 * answer has to say the one thing that decides whether the agent should wait: **a run went out, or it did
 * not**. The three sentences below are that distinction, and they are the tool's contract with the model,
 * which is why they live here where they can be read and tested rather than inline in a hook
 * (docs/decisions.md #225).
 *
 * They come from the same moment the mapping does: the page reports a start when the run exists — the
 * `onRun` hook the canvas already had, the return of `createVideoGenerationTask` — and reports a refusal
 * where the early returns are, so "started" means a run id and nothing less.
 */

import type { RunRequest } from "@/services/api/runs";

/** The outcome of a press: a run exists, or nothing was started and why. */
export type GenerateStart = { started: true; runId: string } | { started: false; reason: string };

/** What the page needs from whoever pressed, and what it may report back. */
export type GenerateOptions = {
    /** The conversation to tell when the run ends — see `RunRequest.askedBy`. */
    askedBy?: RunRequest["askedBy"];
    /** Called once, as soon as it is known whether a run exists. */
    onStart?: (start: GenerateStart) => void;
};

/**
 * The tool's answer: there are two things a press can turn out to be, and it is always one of them.
 *
 * A run exists, so the server owes the agent one message when it ends — delivered even if nobody is listening
 * at the time (`flushRunNotices`). Or no run exists, so the reason is the answer and nothing else is coming.
 *
 * The answer states the fact about *this* run, and gives no instruction. "Do not wait for it and do not poll
 * the node" is a rule about how to work, true of every turn and every canvas, so it lives in the system prompt
 * (`canvasInstructions`) and only there: a rule said in two places is a rule that will disagree with itself
 * (#326).
 *
 * There used to be a third sentence for "the page has not reported anything yet", which promised a message
 * either way and therefore needed a promise-keeper, a late message and a ledger to be true (#285). It was all
 * scaffolding around that promise. A press now answers when the page answers; a page that never answers is
 * answered by the bridge's own "the canvas did not answer", and the agent reads the node to see whether a run
 * took hold.
 */
export function generateAnswer(nodeId: string, mode: string, start: GenerateStart): string {
    if (!start.started) {
        return `generate on ${nodeId} (${mode}) did not start: ${start.reason}. Nothing was queued, so there is nothing to wait for — fix that and press it again.`;
    }
    return `pressed generate on ${nodeId} (${mode}): run ${start.runId} is out. It will take a while — you will be sent a message when it finishes.`;
}
