import path from "node:path";
import { fileURLToPath } from "node:url";

/** Static export: the mission platform server serves the client, so Web and WebXR share one origin. */
const nextConfig = {
  turbopack: { root: path.dirname(fileURLToPath(import.meta.url)) },
  output: "export",
  images: { unoptimized: true },
  reactStrictMode: false,
  transpilePackages: ["@iwsdk/core", "@iwsdk/xr-input", "@iwsdk/locomotor", "@iwsdk/scene-composition"],
};
export default nextConfig;
