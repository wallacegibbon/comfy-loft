import { AgentSettingsControls } from "../agent-settings-controls";
import type { NodeControlsProps } from "./node-controls-props";

/**
 * What a text node's panel shows beside its prompt: its own agent.
 *
 * A text node is answered by an agent rather than by a workflow, so there is no model to pick here — the
 * settings under this cluster are the agent's, and the panel's generate button is the one that starts it.
 */
export function TextControls({ agentName }: NodeControlsProps) {
    return <AgentSettingsControls session={agentName || ""} className="flex min-w-0 items-center gap-2" />;
}
