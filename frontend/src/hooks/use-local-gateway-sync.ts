import { useEffect } from "react";

import { isLocalGatewayUrl, LOCAL_GATEWAY_BASE_URL } from "@/constant/app-mode";
import { gatewayModels, modelSignature, pickModelOption } from "@/lib/gateway-models";
import { noteGatewayError } from "@/services/api/gateway-status";
import { requestWorkflows } from "@/services/api/workflows";
import { encodeChannelModel, modelOptionsFromChannels, useConfigStore, type ChannelModel, type ModelCapability } from "@/stores/use-config-store";

const SYNC_INTERVAL_MS = 8000;
const REQUEST_TIMEOUT_MS = 4000;

const SYNC_CONFIG = { baseUrl: LOCAL_GATEWAY_BASE_URL };

/** Sync models from the gateway automatically, so adding or removing a workflow needs no manual channel refresh. */
export function useLocalGatewaySync() {
    useEffect(() => {
        let stopped = false;
        let timer: number | undefined;

        const applyModels = (models: ChannelModel[]) => {
            const state = useConfigStore.getState();
            const config = state.config;
            const channel = config.channels.find((item) => isLocalGatewayUrl(item.baseUrl)) || config.channels[0];
            if (!channel) return;
            if (!models.length && !channel.models.length) return;

            if (modelSignature(channel.models) === modelSignature(models)) return;

            const channels = config.channels.map((item) => (item.id === channel.id ? { ...item, baseUrl: LOCAL_GATEWAY_BASE_URL, models } : item));
            const optionsFor = (capability: ModelCapability) => channels.flatMap((item) => item.models.filter((model) => model.capability === capability).map((model) => encodeChannelModel(item.id, model.name)));
            const imageOptions = optionsFor("image");
            useConfigStore.setState({
                config: {
                    ...config,
                    channels,
                    models: modelOptionsFromChannels(channels),
                    imageModel: pickModelOption("image", config.imageModel, imageOptions),
                    videoModel: pickModelOption("video", config.videoModel, optionsFor("video")),
                    audioModel: pickModelOption("audio", config.audioModel, optionsFor("audio")),
                    // The image model is also the general one: text-to-image is the default action.
                    model: pickModelOption("image", config.model, imageOptions),
                    baseUrl: LOCAL_GATEWAY_BASE_URL,
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
                applyModels(gatewayModels(workflows));
            } catch (error) {
                // Retry silently while the gateway is still starting so the canvas stays usable; the shared banner reports disconnects.
                noteGatewayError(error, `${LOCAL_GATEWAY_BASE_URL.replace(/\/+$/, "")}/api/workflows`);
            }
            if (!stopped) timer = window.setTimeout(sync, SYNC_INTERVAL_MS);
        };

        void sync();
        const refresh = () => void sync();
        window.addEventListener("local-gateway-refresh-models", refresh);
        return () => {
            stopped = true;
            window.removeEventListener("local-gateway-refresh-models", refresh);
            if (timer) window.clearTimeout(timer);
        };
    }, []);
}
