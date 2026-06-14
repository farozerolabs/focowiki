import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { defineConfig } from "vite";

loadLocalEnvFile();

const adminUiPort = readPort("ADMIN_UI_PORT", "43100");
const adminApiPort = readPort("ADMIN_API_PORT", process.env.PORT ?? "43000");
const adminApiProxyTarget =
  process.env.ADMIN_API_PROXY_TARGET ?? `http://127.0.0.1:${adminApiPort}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname
    }
  },
  server: {
    port: adminUiPort,
    strictPort: true,
    proxy: {
      "/admin/api": adminApiProxyTarget
    }
  }
});

function loadLocalEnvFile() {
  if (process.env.ENV_FILE) {
    loadEnvFile(process.env.ENV_FILE);
    return;
  }

  const candidates = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")];
  const envFile = candidates.find((candidate) => existsSync(candidate));

  if (envFile) {
    loadEnvFile(envFile);
  }
}

function readPort(field: string, fallback: string): number {
  const value = process.env[field] ?? fallback;
  const port = Number.parseInt(value, 10);

  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`${field} must be a valid TCP port`);
  }

  return port;
}
