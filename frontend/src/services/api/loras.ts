import { LOCAL_GATEWAY_BASE_URL } from "@/constant/app-mode";
import { httpJson } from "@/services/api/http";
import { localGatewayRoot } from "@/services/api/image";

const gatewayRoot = localGatewayRoot(LOCAL_GATEWAY_BASE_URL);

/**
 * The LoRA files ComfyUI reports, by path (GET /api/loras).
 *
 * A path, not a name: the same file can live in two folders, and a node that is going to inject one into
 * a workflow has to name the one the loader will find. The list is unsorted and unsanitised — ComfyUI
 * answers with whatever is installed, including files no workflow wants.
 */
export async function fetchLoras(query = ""): Promise<string[]> {
    if (!gatewayRoot) return [];
    const suffix = query ? `?q=${encodeURIComponent(query)}` : "";
    const data = await httpJson<{ loras?: unknown }>(`${gatewayRoot}/api/loras${suffix}`, { timeout: 8000 });
    const loras = Array.isArray(data?.loras) ? data.loras : [];
    return loras.filter((item): item is string => typeof item === "string" && item.length > 0);
}
