import { flushSync } from "react-dom";
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
 *
 * **One call at a time, with a commit between them.** The calls of one turn arrive as separate messages and
 * used to be dispatched as they came, so `canvas_connect` followed by `canvas_generate` read the connections
 * of the *previous* render: the press saw no card, sent an empty prompt, and the server answered 400 in 2 ms
 * — pictures that were never submitted, and an agent waiting for news about them (measured on a real canvas,
 * #285). The tools read the page's refs, and those refs are written in a layout effect, so a call must not
 * start until the call before it has been committed — `flushSync` is that, where waiting for a frame was a
 * guess that held on one machine and not on the next.
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
    resizeNode,
    groupNodes,
    ungroupNodes,
    nodeContract,
    writeSettings,
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
    resizeNode: CanvasHands["resizeNode"];
    groupNodes: CanvasHands["groupNodes"];
    ungroupNodes: CanvasHands["ungroupNodes"];
    nodeContract: CanvasHands["nodeContract"];
    writeSettings: CanvasHands["writeSettings"];
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
        resizeNode,
        groupNodes,
        ungroupNodes,
        nodeContract,
        writeSettings,
    });
    hands.current = {
        nodes: () => nodesRef.current || [],
        connections: () => connectionsRef.current || [],
        createNode: committed(createNode),
        generateNode,
        setNodePrompt: committed(setNodePrompt),
        writeText: committed(writeText),
        connectNodes: committedAnswer(connectNodes),
        deleteNodes: committed(deleteNodes),
        focusNode,
        moveNode: committed(moveNode),
        resizeNode: committed(resizeNode),
        groupNodes: committed(groupNodes),
        ungroupNodes: committed(ungroupNodes),
        nodeContract,
        writeSettings: committed(writeSettings),
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

/**
 * A hand that changes the canvas, and is finished changing it before it returns.
 *
 * The tools read the page's refs, and those refs are written in a layout effect — one commit *after* the
 * `setNodes`/`setConnections` that changed them. A turn that connects a card and then presses generate fires
 * both calls in the same tick, so without this the press read the connections of the previous render: no
 * card, an empty prompt, a 400 two milliseconds later — pictures that were never submitted, and an agent
 * waiting for news about them (measured on a real canvas, #285).
 *
 * `flushSync` around the write is what closes it: the update is committed, the layout effect has run, and the
 * ref every tool reads is the one this call just wrote. Waiting a frame instead was a guess — and an empty
 * `flushSync(() => {})` after the call does not work at all: it flushes the updates queued *inside* it, and
 * there are none.
 */
function committed<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A) => {
        let result!: R;
        flushSync(() => {
            result = fn(...args);
        });
        return result;
    };
}

/** The same, for a hand that answers whether it could do the thing. */
function committedAnswer<A extends unknown[]>(fn: (...args: A) => boolean): (...args: A) => boolean {
    return (...args: A) => {
        let done = false;
        flushSync(() => {
            done = fn(...args);
        });
        return done;
    };
}
