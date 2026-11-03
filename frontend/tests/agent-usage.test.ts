import { describe, expect, it } from "vitest";

import { contextSegment, speedSegment } from "@/lib/canvas/agent-usage";
import type { AgentUsage } from "@/services/api/agent";

/**
 * The panel's context and speed readout.
 *
 * The numbers are AlayaCore's own measurements and this is only how they read, so the format is the one
 * its status bar uses (`formatTokenCount` in `internal/adapters/terminal/tui_status.go`): a whole
 * thousand keeps no decimal, so a million-token context reads `1M` beside `22K` (#224).
 */

const usage = (fields: Partial<AgentUsage>): AgentUsage => ({ contextTokens: 0, stepTps: 0, ttftMs: 0, ...fields });

describe("the agent's own two numbers", () => {
    it("writes a token count the way the agent's status bar does", () => {
        // Both sides of the pair, through the one function that renders a count.
        expect(contextSegment(860, 0)).toBe("860");
        expect(contextSegment(1500, 0)).toBe("1.5K");
        expect(contextSegment(262_144, 0)).toBe("262.1K");
        expect(contextSegment(1_500_000, 0)).toBe("1.5M");
        expect(contextSegment(1_000_000, 2_000_000)).toBe("1M/2M 50.0%");
    });

    it("reads the context as tokens over the model's limit, with the share of it", () => {
        expect(contextSegment(22_000, 1_000_000)).toBe("22K/1M 2.2%");
        expect(contextSegment(1500, 8000)).toBe("1.5K/8K 18.8%");
    });

    it("says only how much is used when the model does not say how much it holds", () => {
        // A percentage of an unknown limit is not a number worth inventing.
        expect(contextSegment(1500, 0)).toBe("1.5K");
        expect(contextSegment(0, 8000)).toBe("");
    });

    it("reads the speed of the last step, with the wait for its first token", () => {
        expect(speedSegment(usage({ contextTokens: 22_000, stepTps: 129.5, ttftMs: 800 }))).toBe("129.5 tok/s (ttft 0.8s)");
        // A provider that reported no first-token time still reported a speed.
        expect(speedSegment(usage({ stepTps: 12.5 }))).toBe("12.5 tok/s");
    });

    it("says nothing about speed for a step that produced no output tokens", () => {
        // AlayaCore reports no speed until a step has output tokens, and a tool-call step that had none
        // reports 0 — a `0.0 tok/s` on screen would read as a stalled model.
        expect(speedSegment(usage({ contextTokens: 8600, stepTps: 0, ttftMs: 1200 }))).toBe("");
    });

    it("is the line the panel draws, in the order it draws it", () => {
        const reported = usage({ contextTokens: 22_000, stepTps: 129.5, ttftMs: 800 });
        expect([contextSegment(reported.contextTokens, 1_000_000), speedSegment(reported)].filter(Boolean).join(" | ")).toBe("22K/1M 2.2% | 129.5 tok/s (ttft 0.8s)");
    });
});
