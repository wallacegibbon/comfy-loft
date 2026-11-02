import { LOCAL_GATEWAY_BASE_URL } from "@/constant/app-mode";
import { httpJson } from "@/services/api/http";

/**
 * The workspace preferences, as the gateway keeps them (#155).
 *
 * The document is opaque on both sides: the gateway stores the bytes without reading a key, and this
 * module passes them through without knowing what is in them. The shape lives in
 * `stores/use-settings-store.ts`, one level up, where the keys are actually named.
 */

const URL = `${LOCAL_GATEWAY_BASE_URL}/api/settings`;

export type SettingsBlob = Record<string, unknown>;

export async function requestSettings(): Promise<SettingsBlob> {
    const payload = await httpJson<{ settings?: SettingsBlob }>(URL, { timeout: 8000 });
    return payload?.settings && typeof payload.settings === "object" ? payload.settings : {};
}

export async function requestSettingsSave(settings: SettingsBlob): Promise<SettingsBlob> {
    const payload = await httpJson<{ settings?: SettingsBlob }>(URL, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings }),
        timeout: 8000,
    });
    return payload?.settings && typeof payload.settings === "object" ? payload.settings : settings;
}
