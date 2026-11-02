import i18n from "@/i18n";
import { askOnceAgentSession, openAgentSession, type AgentEvent } from "@/services/api/agent";
import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";

/** The H3 task types, as the skill names them. */
export type PromptOptimizeMode = "全参考模式(Reference to Video)" | "文生视频(T2VA)" | "首帧图生视频(I2VA)" | "首尾帧视频(FL2VA)" | "尾帧图生视频(L2VA)";

/**
 * Ask the agent for words: one prompt in, one answer out, read as it arrives.
 *
 * `session` is whose agent is being asked — a text node's body is written by that node's own session,
 * the one its panel connected on the model the user chose there, and never by the canvas's agent.
 *
 * The session is opened here if it is not open yet, which is the whole of "connect": a caller that
 * reaches this without a panel (a retry, a script) still gets an agent, and the one that does have a
 * panel gets the session it already made — same name, same process. It is released when the answer
 * ends: this is one question, and asking again starts a new agent.
 */
export async function requestPromptChat(session: string, config: AiConfig, params: { prompt: string; images?: ReferenceImage[] }, options?: { signal?: AbortSignal; onDelta?: (text: string) => void }): Promise<string> {
    await openAgentSession(config, session);
    let streamed = "";
    const answer = await askOnceAgentSession(
        session,
        { prompt: params.prompt, images: params.images },
        {
            signal: options?.signal,
            onEvent: (event: AgentEvent) => {
                if (event.type !== "delta" || !event.text) return;
                streamed += event.text;
                options?.onDelta?.(streamed);
            },
        },
    );
    const text = (answer || streamed).trim();
    // A turn that ends without a word is a failure, not an answer: writing the empty string into the node
    // made it look as though nothing had happened at all (#160). The agent closes its session when it
    // gives up, and that close is what used to arrive here as a silent success.
    if (!text) throw new Error(i18n.t("canvas.runtime.agentEmptyAnswer"));
    return text;
}
