import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

function resolveBackendOrigin(raw: string, key: string, allowLegacyPath = false): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`${key} must be an absolute http(s) URL`);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${key} must be an http(s) origin without credentials, query, or fragment`);
  }
  if (url.pathname !== "/" && url.pathname !== "" && !(allowLegacyPath && /^\/api\/v1(?:\/.*)?\/?$/.test(url.pathname))) {
    throw new Error(`${key} must be an origin URL without a path`);
  }
  return url.origin;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "../", "");
  const candidates: Array<[string, string, boolean]> = [
    ["FARMOS_API_URL", env.FARMOS_API_URL || "", false],
    ["BACKEND_URL", env.BACKEND_URL || "", false],
    ["MOBILE_API_BASE_URL", env.MOBILE_API_BASE_URL || "", true],
    ["BACKEND_API_URL", env.BACKEND_API_URL || "", true],
  ];
  const selected = candidates.find(([, value]) => value.trim());
  const backendOrigin = selected
    ? resolveBackendOrigin(selected[1], selected[0], selected[2])
    : `http://localhost:${env.PORT || "5001"}`;
  if (selected && selected[0] !== "FARMOS_API_URL") {
    console.warn(`Frontend proxy config warning: ${selected[0]} is deprecated; use FARMOS_API_URL`);
  }

  return {
    plugins: [react()],
    envDir: "../", // Load .env từ thư mục root của project
    server: {
      port: 5173,
      proxy: {
        "/api": {
          target: backendOrigin,
          changeOrigin: true,
        },
        "/socket.io": {
          target: backendOrigin,
          ws: true,
        },
      },
    },
  };
});
