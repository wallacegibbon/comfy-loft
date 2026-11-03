import { useEffect, useRef, type RefObject } from "react";

import { onAnyAgentEvent, sendAgentMessage, type ToolContent } from "@/services/api/agent";
import { runTool, type CanvasHands } from "@/lib/canvas/canvas-agent-tools";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

/**
 * The canvas's hands: the wiring between the agent's socket and the page's own state.
 *
 * A tool call arrives here — `{"type":"tool","callId":…,"name":…,"arguments":…}` — and the answer goes back
 * on the same session it came from. Whatever the user's buttons do, a tool does; nothing here is a second
 * way to change a canvas. What each tool *decides* lives in `lib/canvas/canvas-agent-tools`, which is a
 * function of the hands it is given and can be tested without a page.
 *
 * It answers every session, not just the canvas panel's: the canvas is one, and a node's agent asking to
 * see it is the same question as the panel's agent asking.
 */
export function useCanvasAgentTools({
    nodesRef,
    connectionsRef,
    createNode,
    generateNode,
    setNodePrompt,
    writeText,
    connectNodes,
    deleteNodes,
    focusNode,
    moveNode,
}: {
    nodesRef: RefObject<CanvasNodeData[]>;
    connectionsRef: RefObject<CanvasConnection[]>;
    createNode: CanvasHands["createNode"];
    generateNode: CanvasHands["generateNode"];
    setNodePrompt: CanvasHands["setNodePrompt"];
    writeText: CanvasHands["writeText"];
    connectNodes: CanvasHands["connectNodes"];
    deleteNodes: CanvasHands["deleteNodes"];
    focusNode: CanvasHands["focusNode"];
    moveNode: CanvasHands["moveNode"];
}) {
    // The refs and callbacks outlive a render, and a tool call can arrive between two of them.
    const hands = useRef<CanvasHands>({
        nodes: () => [],
        connections: () => [],
        createNode,
        generateNode,
        setNodePrompt,
        writeText,
        connectNodes,
        deleteNodes,
        focusNode,
        moveNode,
    });
    hands.current = {
        nodes: () => nodesRef.current || [],
        connections: () => connectionsRef.current || [],
        createNode,
        generateNode,
        setNodePrompt,
        writeText,
        connectNodes,
        deleteNodes,
        focusNode,
        moveNode,
    };

    useEffect(
        () =>
            onAnyAgentEvent((session, event) => {
                if (event.type !== "tool" || !event.callId) return;
                const callId = event.callId;
                const answer = (content: ToolContent[], isError?: boolean) => sendAgentMessage(session, { toolResult: { callId, content, isError } });
                void runTool(event.name || "", event.arguments, hands.current, session).then(
                    (result) => answer(result.content, result.isError),
                    (error: unknown) => answer([{ type: "text", text: error instanceof Error ? error.message : String(error) }], true),
                );
            }),
        [],
    );
}
