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

/**
 * How long a press may take to report a run before the tool answers anyway.
 *
 * A press is synchronous up to the first `await`, and what follows is local work — hydrating the node's
 * context, uploading a reference that is not a canvas file yet — so a second is a slow press. The bound
 * exists because the agent is holding a turn open on this answer and the MCP call itself gives up at 30 s.
 */
export const GENERATE_START_WAIT_MS = 15_000;

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
 * The tool's answer, from what the page reported.
 *
 * `start` is absent when nothing was reported in time: a press that is still setting up is neither of the
 * other two, and claiming either would be a guess in the direction that costs the most — "started" leaves
 * the agent waiting on a message that may never come, "did not start" abandons a run that is about to.
 *
 * What the missing case may not do is promise nothing, which is what it said until #285: "if it does not,
 * nothing was produced" told the agent a silence was possible, and a turn that is waiting for a message
 * has no way to end. Every press is now closed exactly once — a run ends and the server tells the session,
 * or there is no run and the page says so itself (`pressAndWait` hands the late word to the agent) — so the
 * sentence above is a promise the canvas keeps rather than a hope.
 */
export function generateAnswer(nodeId: string, mode: string, start: GenerateStart | undefined): string {
    if (!start) {
        return `pressed generate on ${nodeId} (${mode}), and no run was reported within ${Math.round(GENERATE_START_WAIT_MS / 1000)}s — it is still setting up. You will be sent one message when it is over, whether it worked or failed, so do not wait for it and do not press it again.`;
    }
    if (!start.started) {
        return `generate on ${nodeId} (${mode}) did not start: ${start.reason}. Nothing was queued, so there is nothing to wait for — fix that and press it again.`;
    }
    return `pressed generate on ${nodeId} (${mode}): run ${start.runId} is out. It will take a while — you will be sent a message when it finishes, so do not wait for it or poll the node.`;
}
