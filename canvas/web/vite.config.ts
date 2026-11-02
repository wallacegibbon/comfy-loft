import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const webDir = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(webDir, "../..");
// The version string is optional: without a VERSION file the bundle says "dev".
const versionPath = [resolve(appRoot, "VERSION"), resolve(webDir, "../VERSION")].find((file) => existsSync(file));
const localVersion = versionPath ? readFileSync(versionPath, "utf8").trim() || "dev" : "dev";

// Vendor code is split by library family so the app entry does not have to be re-downloaded
// when only app code changes, and no single chunk dwarfs the rest. The entries are only a
// cache boundary: rollup keeps the execution order of side effects. The rule for antd (and
// its @rc-component/rc-*/dayjs satellites) was deleted with the dependency itself.
function vendorChunk(id: string): string | undefined {
    if (!id.includes("node_modules")) return undefined;
    if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "react";
    if (/[\\/]node_modules[\\/]three[\\/]/.test(id)) return "three";
    return "vendor";
}

export default defineConfig({
    base: process.env.VITE_BASE || "/",
    plugins: [react()],
    resolve: {
        alias: {
            "@": resolve(webDir, "src"),
        },
    },
    define: {
        __APP_VERSION__: JSON.stringify(localVersion),
    },
    build: {
        // The bundle is served from the same machine, so bytes on the wire are cheap;
        // the split above exists so a change to app code does not invalidate the
        // vendor chunks. The default 500 kB threshold is therefore noise here, but it
        // is kept as a guard against the bundle quietly doubling.
        chunkSizeWarningLimit: 1200,
        rollupOptions: {
            output: {
                manualChunks: vendorChunk,
            },
        },
    },
});
