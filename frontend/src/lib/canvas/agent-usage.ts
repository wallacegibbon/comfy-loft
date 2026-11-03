/**
 * The two numbers the agent reports about itself, written the way its own status bar writes them.
 *
 * Nothing here is measured or estimated: `context_tokens`, `step_tps` and `ttft_ms` come down the socket
 * exactly as AlayaCore stated them (#224), and this is only how they read. The format is AlayaCore's own
 * (`formatTokenCount` and the two segments in `internal/adapters/terminal/tui_status.go`), so the panel
 * and the agent's terminal never disagree about the same session:
 *
 *     22K/1M 2.2%  |  129.5 tok/s (ttft 0.8s)
 *
 * The one difference is the separator, which is drawn by the panel because the row can wrap.
 */

import type { AgentUsage } from "@/services/api/agent";

/**
 * One token count: `860`, `1.5K`, `22K`, `262.1K`, `1M`.
 *
 * A whole thousand or million keeps no decimal, which is why a million-token context reads `1M` and not
 * `1.0M` — the number is compared with the limit beside it, not admired.
 */
function tokenCount(tokens: number): string {
    if (tokens < 1_000) return String(Math.round(tokens));
    const [value, unit] = tokens < 1_000_000 ? [tokens / 1_000, "K"] : [tokens / 1_000_000, "M"];
    return Number.isInteger(value) ? `${value}${unit}` : `${value.toFixed(1)}${unit}`;
}

/**
 * How full the context is: `22K/1M 2.2%`, or the count alone when the model does not say how much it
 * holds — a percentage of an unknown limit is not a number worth inventing.
 */
export function contextSegment(tokens: number, limit: number): string {
    if (tokens <= 0) return "";
    if (limit <= 0) return tokenCount(tokens);
    return `${tokenCount(tokens)}/${tokenCount(limit)} ${((tokens * 100) / limit).toFixed(1)}%`;
}

/**
 * How fast the last step went: `129.5 tok/s (ttft 0.8s)`.
 *
 * Nothing before a step has produced output tokens — the agent reports no speed for a step that only
 * called a tool, and a `0.0 tok/s` would read as a stalled model.
 */
export function speedSegment(usage: AgentUsage): string {
    if (usage.stepTps <= 0) return "";
    if (usage.ttftMs <= 0) return `${usage.stepTps.toFixed(1)} tok/s`;
    return `${usage.stepTps.toFixed(1)} tok/s (ttft ${(usage.ttftMs / 1000).toFixed(1)}s)`;
}
