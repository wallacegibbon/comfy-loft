import { useEffect } from "react";

import { isLocalServerUrl, LOCAL_SERVER_BASE_URL } from "@/constant/app-mode";
import { serverModels, modelSignature, pickModelOption } from "@/lib/server-models";
import { noteServerError } from "@/services/api/server-status";
import { requestWorkflows } from "@/services/api/workflows";
import { encodeChannelModel, modelOptionsFromChannels, useConfigStore, type ChannelModel, type ModelCapability } from "@/stores/use-config-store";

const SYNC_INTERVAL_MS = 8000;
const REQUEST_TIMEOUT_MS = 4000;

const SYNC_CONFIG = { baseUrl: LOCAL_SERVER_BASE_URL };

/** Sync models from the server automatically, so adding or removing a workflow needs no manual channel refresh. */
export function useLocalServerSync() {
    useEffect(() => {
        let stopped = false;
        let timer: number | undefined;

        const applyModels = (models: ChannelModel[]) => {
            const state = useConfigStore.getState();
            const config = state.config;
            const channel = config.channels.find((item) => isLocalServerUrl(item.baseUrl)) || config.channels[0];
            if (!channel) return;
            if (!models.length && !channel.models.length) return;

            if (modelSignature(channel.models) === modelSignature(models)) return;

            const channels = config.channels.map((item) => (item.id === channel.id ? { ...item, baseUrl: LOCAL_SERVER_BASE_URL, models } : item));
            // A tool takes a clip and has nothing to be asked, so it can never be the model a fresh node
            // starts on — only one a node is deliberately set to.
            const defaultOptionsFor = (capability: ModelCapability) => channels.flatMap((item) => item.models.filter((model) => model.capability === capability && !model.tool).map((model) => encodeChannelModel(item.id, model.name)));
            useConfigStore.setState({
                config: {
                    ...config,
                    channels,
                    models: modelOptionsFromChannels(channels),
                    imageModel: pickModelOption("image", config.imageModel, defaultOptionsFor("image")),
                    videoModel: pickModelOption("video", config.videoModel, defaultOptionsFor("video")),
                    audioModel: pickModelOption("audio", config.audioModel, defaultOptionsFor("audio")),
                    // The image model is also the general one: text-to-image is the default action.
                    model: pickModelOption("image", config.model, defaultOptionsFor("image")),
                    baseUrl: LOCAL_SERVER_BASE_URL,
                },
            });
        };

        const sync = async () => {
            if (timer) {
                window.clearTimeout(timer);
                timer = undefined;
            }
            try {
                const controller = new AbortController();
                const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
                const workflows = await requestWorkflows(SYNC_CONFIG, { signal: controller.signal }).finally(() => window.clearTimeout(timeout));
                applyModels(serverModels(workflows));
            } catch (error) {
                // Retry silently while the server is still starting so the canvas stays usable; the shared banner reports disconnects.
                noteServerError(error, `${LOCAL_SERVER_BASE_URL.replace(/\/+$/, "")}/api/workflows`);
            }
            if (!stopped) timer = window.setTimeout(sync, SYNC_INTERVAL_MS);
        };

        void sync();
        const refresh = () => void sync();
        window.addEventListener("local-server-refresh-models", refresh);
        return () => {
            stopped = true;
            window.removeEventListener("local-server-refresh-models", refresh);
            if (timer) window.clearTimeout(timer);
        };
    }, []);
}
