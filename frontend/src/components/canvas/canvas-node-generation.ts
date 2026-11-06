import { imageToDataUrl } from "@/services/image-storage";
import i18n from "@/i18n";
import { NODE_STATUS_ERROR, NODE_STATUS_LOADING } from "@/lib/canvas/canvas-node-status";
import { nodeContentOf } from "@/lib/canvas/node-prompt-field";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import { generationInputCandidates, getGenerationResourceNodes, getGroupResourceNodes } from "@/lib/canvas/canvas-resource-references";
import { getNodeDefinition } from "@/lib/canvas/node-registry";

type NodeLora = { name: string; strength: number };

export type NodeGenerationContext = {
    prompt: string;
    referenceImages: ReferenceImage[];
    referenceVideos: ReferenceVideo[];
    referenceAudios: ReferenceAudio[];
    loras: NodeLora[];
    textCount: number;
    imageCount: number;
    videoCount: number;
    audioCount: number;
};

type NodeGenerationResourceInput = {
    nodeId: string;
    type: "text" | "image" | "video" | "audio" | "lora";
    title: string;
    text?: string;
    image?: ReferenceImage;
    video?: ReferenceVideo;
    audio?: ReferenceAudio;
    loras?: NodeLora[];
};

type NodeGenerationGroupInput = {
    nodeId: string;
    type: "group";
    title: string;
    children: NodeGenerationResourceInput[];
};

type NodeGenerationInput = NodeGenerationResourceInput | NodeGenerationGroupInput;

export function buildNodeGenerationContext(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[], prompt: string): NodeGenerationContext {
    const inputs = buildNodeGenerationInputs(nodeId, nodes, connections);

    const resourceInputs = flattenGenerationInputs(inputs);
    let textIndex = 0;
    const upstreamText = resourceInputs.flatMap((input) => (input.text ? [textBlock(i18n.t("canvas.references.textLabel", { index: ++textIndex }), input.text)] : [])).join("\n\n");
    const referenceImages = resourceInputs.map((input) => input.image).filter((image): image is ReferenceImage => Boolean(image));
    const referenceVideos = resourceInputs.map((input) => input.video).filter((video): video is ReferenceVideo => Boolean(video));
    const referenceAudios = resourceInputs.map((input) => input.audio).filter((audio): audio is ReferenceAudio => Boolean(audio));
    const loras = resourceInputs.flatMap((input) => (input.type === "lora" ? input.loras || [] : []));

    return {
        prompt: upstreamText ? `${prompt}\n\n${upstreamText}` : prompt,
        referenceImages,
        referenceVideos,
        referenceAudios,
        loras,
        textCount: resourceInputs.filter((input) => input.type === "text").length,
        imageCount: referenceImages.length,
        videoCount: referenceVideos.length,
        audioCount: referenceAudios.length,
    };
}

function buildNodeGenerationInputs(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]): NodeGenerationInput[] {
    return getGenerationResourceNodes(nodeId, nodes, connections).flatMap((node): NodeGenerationInput[] => {
        if (node.type === CanvasNodeType.Group) {
            const children = getGroupResourceNodes(node.id, nodes).flatMap(readNodeGenerationResource);
            return children.length ? [{ nodeId: node.id, type: "group", title: node.id, children }] : [];
        }
        return readNodeGenerationResource(node);
    });
}

function flattenGenerationInputs(inputs: NodeGenerationInput[]) {
    const resources = inputs.flatMap((input) => (input.type === "group" ? input.children : [input]));
    return [...new Map(resources.map((input) => [input.nodeId, input])).values()];
}

/**
 * The connected inputs whose words a prompt repeats — the ids of the text nodes a node would say twice.
 *
 * A text node connected to a node is an input, and its words are appended to that node's own prompt when
 * it generates. The same words in both places are therefore said twice, which is what a model does when it
 * believes the connection is decoration: the panel never copies a connected text into the box (#185), but
 * `create_node` lets an agent write it, and this is how the agent's own tools can say so (#203). Identical
 * after trimming is the test, on purpose — an input whose words happen to appear inside a longer prompt is
 * not this mistake, and warning about it would fire on correct work.
 */
export function repeatedConnectedText(nodeId: string, prompt: string, nodes: CanvasNodeData[], connections: CanvasConnection[]): string[] {
    const words = prompt.trim();
    if (!words) return [];
    return flattenGenerationInputs(buildNodeGenerationInputs(nodeId, nodes, connections))
        .filter((input) => input.type === "text" && (input.text || "").trim() === words)
        .map((input) => input.nodeId);
}

function readNodeGenerationResource(node: CanvasNodeData): NodeGenerationResourceInput[] {
    const image = readReferenceImage(node);
    if (image) return [{ nodeId: node.id, type: "image", title: node.id, image }];
    const video = readReferenceVideo(node);
    if (video) return [{ nodeId: node.id, type: "video", title: node.id, video }];
    const audio = readReferenceAudio(node);
    if (audio) return [{ nodeId: node.id, type: "audio", title: node.id, audio }];
    const resource = getNodeDefinition(node.type)?.resource?.(node);
    if (resource?.kind === "image" && resource.url)
        return [{ nodeId: node.id, type: "image", title: node.id, image: { id: node.id, name: mediaFileName(node.id, "png"), type: node.metadata?.mimeType || "image/png", dataUrl: resource.url, storageKey: node.metadata?.storageKey } }];
    if (resource?.kind === "video" && resource.url)
        return [{ nodeId: node.id, type: "video", title: node.id, video: { id: node.id, name: mediaFileName(node.id, "mp4"), type: node.metadata?.mimeType || "video/mp4", url: resource.url, storageKey: node.metadata?.storageKey } }];
    if (resource?.kind === "audio" && resource.url)
        return [{ nodeId: node.id, type: "audio", title: node.id, audio: { id: node.id, name: mediaFileName(node.id, "mp3"), type: node.metadata?.mimeType || "audio/mpeg", url: resource.url, storageKey: node.metadata?.storageKey } }];
    if (resource?.kind === "lora" && resource.loras?.length) return [{ nodeId: node.id, type: "lora", title: node.id, loras: resource.loras }];
    if (resource?.kind === "text" && resource.text) return [{ nodeId: node.id, type: "text", title: node.id, text: resource.text }];
    // The words, and only the words this node holds. Asked here rather than only through the node's
    // definition so a module that has not registered the built-in definitions — a test, a fresh import —
    // answers the same way, and both roads lead through `nodeContentOf` (#230).
    const text = nodeContentOf(node);
    return text ? [{ nodeId: node.id, type: "text", title: node.id, text }] : [];
}

/**
 * The wires into a node that would carry nothing, and why.
 *
 * A wire is a promise — "use this" — so a node that holds nothing is not a smaller input, it is a promise
 * the run cannot keep. Until #230 the run went ahead anyway and made something up: an empty image node
 * offered its prompt as though the words it was asked were something it had, which is the same
 * substitution that put one node's question into another node's request. Now the run refuses, and names
 * the node, so the answer is the same whether a person or the agent pressed the button.
 */
export function inputsHoldingNothing(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]): EmptyInput[] {
    return generationInputCandidates(nodeId, nodes, connections)
        .filter((node) => carriesNothing(node, nodes))
        .map((node) => ({ node, state: emptyInputStateOf(node) }));
}

type EmptyInput = {
    node: CanvasNodeData;
    /** Empty, still being made, or the last run failed — what the refusal tells the reader to do about it. */
    state: "empty" | "running" | "failed";
};

/** A group carries what its children hold; every other node carries what `readNodeGenerationResource` finds. */
function carriesNothing(node: CanvasNodeData, nodes: CanvasNodeData[]): boolean {
    if (node.type === CanvasNodeType.Group) return getGroupResourceNodes(node.id, nodes).length === 0;
    return readNodeGenerationResource(node).length === 0;
}

function emptyInputStateOf(node: CanvasNodeData): EmptyInput["state"] {
    if (node.metadata?.status === NODE_STATUS_LOADING) return "running";
    if (node.metadata?.status === NODE_STATUS_ERROR) return "failed";
    return "empty";
}

/**
 * The refusal in the words the agent is answered with: one sentence per node, saying what it has not got
 * and the two ways out. The person who pressed generate reads the same fact in their own language.
 */
export function describeEmptyInputs(inputs: EmptyInput[]): string {
    return inputs
        .map(({ node, state }) => {
            const name = `${node.id} (${node.type})`;
            if (state === "running") return `${name} is still being made, so the connection from it carries nothing yet: wait for it to finish, or remove the connection`;
            if (state === "failed") return `${name}'s last run failed, so the connection from it carries nothing: run it again, or remove the connection`;
            return `${name} holds nothing yet, so the connection from it carries nothing: fill it in first, or remove the connection`;
        })
        .join("; ");
}

export async function hydrateNodeGenerationContext(context: NodeGenerationContext) {
    return { ...context, referenceImages: await Promise.all(context.referenceImages.map(async (image) => ({ ...image, dataUrl: await imageToDataUrl(image) }))) };
}

/** One connected text, labelled: 【文本1】 over its words, so the model can tell two inputs apart. */
function textBlock(label: string, text: string) {
    return `【${label}】\n${text}`;
}

const MEDIA_EXTENSION_RE = /\.(png|jpe?g|webp|gif|bmp|mp4|webm|mov|mkv|avi|mp3|wav|ogg|m4a|flac)$/i;

/**
 * A file name for the media a run is handed: the node's id, with the extension its container implies.
 *
 * It used to be the node's title — eleven pictures called "Image" all sent `Image.png`, so a run that took
 * two of them could not tell the two apart in its own log.
 */
function mediaFileName(id: string, extension: string) {
    const name = id.trim();
    return MEDIA_EXTENSION_RE.test(name) ? name : `${name}.${extension}`;
}

function readReferenceImage(node: CanvasNodeData): ReferenceImage | null {
    if (node.type !== CanvasNodeType.Image || !node.metadata?.content) return null;
    return {
        id: node.id,
        name: mediaFileName(node.id, "png"),
        type: node.metadata.mimeType || "image/png",
        dataUrl: node.metadata.content,
        storageKey: node.metadata.storageKey,
    };
}

function readReferenceVideo(node: CanvasNodeData): ReferenceVideo | null {
    if (node.type !== CanvasNodeType.Video || !node.metadata?.content) return null;
    return {
        id: node.id,
        name: mediaFileName(node.id, "mp4"),
        type: node.metadata.mimeType || "video/mp4",
        url: node.metadata.content,
        storageKey: node.metadata.storageKey,
        bytes: node.metadata.bytes,
        width: node.metadata.naturalWidth,
        height: node.metadata.naturalHeight,
        durationMs: node.metadata.durationMs,
    };
}

function readReferenceAudio(node: CanvasNodeData): ReferenceAudio | null {
    if (node.type !== CanvasNodeType.Audio || !node.metadata?.content) return null;
    return {
        id: node.id,
        name: mediaFileName(node.id, "mp3"),
        type: node.metadata.mimeType || "audio/mpeg",
        url: node.metadata.content,
        storageKey: node.metadata.storageKey,
        durationMs: node.metadata.durationMs,
    };
}
