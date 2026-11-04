import { describe, expect, it } from "vitest";

import { IMAGE_ANGLE_WORKFLOW, IMAGE_UPSCALE_WORKFLOW, isToolWorkflow, VIDEO_INTERPOLATE_WORKFLOW } from "@/lib/canvas/tool-workflows";

/**
 * Which workflows are steps.
 *
 * The server registers a workflow and reports whether it can run; whether it is a *step* — something that
 * takes a clip or a picture and a knob rather than a prompt — is the canvas's own judgement, because the
 * canvas is the only client. A step is still a node's model; it is only never a new node's default.
 */
describe("tool workflows", () => {
    it("are the ones the canvas drives from an action", () => {
        for (const id of [VIDEO_INTERPOLATE_WORKFLOW, IMAGE_UPSCALE_WORKFLOW, IMAGE_ANGLE_WORKFLOW]) {
            expect(isToolWorkflow(id)).toBe(true);
        }
    });

    it("do not include the workflows that are picked from the model list", () => {
        for (const id of ["video-h3-frames", "video-h3-t2v", "image-qwen21", "image-z-image-turbo", "audio-minimax-music-3"]) {
            expect(isToolWorkflow(id)).toBe(false);
        }
    });
});
