import { LOCAL_GATEWAY_ORIGIN } from "@/constant/app-mode";

/**
 * The gateway's reachability, as the page learns it from its own traffic.
 *
 * There used to be a heartbeat here: after the first failure a timer probed `GET /health` every two
 * seconds until it answered, and then reloaded the page. Two things made that unnecessary (#157):
 *
 *   - **Recovery is already in the traffic.** The model list is refreshed every few seconds and the
 *     system chip is polled; the first one of those to succeed is the same news a probe would bring,
 *     a few seconds later and for free.
 *   - **The reload existed to refresh stale state** — model lists, resource status — that the polls
 *     now refresh on their own. All it still did was throw away what the tab held: the undo stack,
 *     the selection, whatever was being dragged.
 *
 * So there is no timer, no probe and no reload. The state is derived: a gateway request that fails at
 * the network layer marks it down, any gateway response marks it up, and the banner follows. The
 * `/health` endpoint still exists — it reports ComfyUI's reachability and the workflow count, which is
 * a question for an operator with `curl`, not for a page to ask itself over and over.
 */

type Listener = (down: boolean) => void;

const listeners = new Set<Listener>();

let down = false;

function emit() {
    for (const listener of listeners) listener(down);
}

export function isGatewayDown() {
    return down;
}

export function subscribeGatewayStatus(listener: Listener) {
    listeners.add(listener);
    listener(down);
    return () => {
        listeners.delete(listener);
    };
}

function markGatewayDown() {
    if (down) return;
    down = true;
    emit();
}

/** The gateway answered something. Called from the HTTP layer, so every successful request counts. */
function markGatewayUp() {
    if (!down) return;
    down = false;
    emit();
}

function isGatewayRequest(url: string) {
    if (!url) return false;
    try {
        const target = new URL(url, LOCAL_GATEWAY_ORIGIN || window.location.origin);
        return Boolean(LOCAL_GATEWAY_ORIGIN) && target.origin === LOCAL_GATEWAY_ORIGIN;
    } catch {
        return false;
    }
}

/**
 * Record what a response means for reachability.
 *
 * Any status counts, including an error one: a 400 from the gateway is a gateway that is answering.
 */
export function noteGatewayResponse(url: string) {
    if (isGatewayRequest(url)) markGatewayUp();
}

export function noteGatewayError(error: unknown, url = "") {
    const maybe = error as { code?: string; response?: unknown; config?: { url?: string; baseURL?: string } } | null;
    const isNetworkError = error instanceof TypeError || (maybe?.code === "ERR_NETWORK" && !maybe?.response);
    if (!isNetworkError) return;
    const requestUrl = url || maybe?.config?.url || "";
    const requestBase = maybe?.config?.baseURL || "";
    if (!requestUrl || isGatewayRequest(requestUrl) || isGatewayRequest(requestBase)) markGatewayDown();
}

export async function gatewayFetch(input: RequestInfo | URL, init?: RequestInit) {
    try {
        const response = await fetch(input, init);
        noteGatewayResponse(String(input));
        return response;
    } catch (error) {
        noteGatewayError(error, String(input));
        throw error;
    }
}
