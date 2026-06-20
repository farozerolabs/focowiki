import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { defineConfig, type Plugin } from "vite";

loadLocalEnvFile();

const adminUiPort = readPort("ADMIN_UI_PORT", "43100");
const adminUiHost = readHost("ADMIN_UI_HOST", "::");
const adminApiPort = readPort("ADMIN_API_PORT", process.env.PORT ?? "43000");
const adminApiProxyTarget =
  process.env.ADMIN_API_PROXY_TARGET ?? `http://127.0.0.1:${adminApiPort}`;
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "font-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self' http: https: ws: wss:",
  "form-action 'self'"
].join("; ");

export default defineConfig({
  plugins: [stripProductionDebugOutput(), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname
    }
  },
  build: {
    sourcemap: false
  },
  server: {
    host: adminUiHost,
    port: adminUiPort,
    strictPort: true,
    headers: {
      "Content-Security-Policy": contentSecurityPolicy,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY"
    },
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

function readHost(field: string, fallback: string): string {
  const value = process.env[field]?.trim() || fallback;

  if (!value) {
    throw new Error(`${field} must be a non-empty host`);
  }

  return value;
}

function stripProductionDebugOutput(): Plugin {
  return {
    name: "focowiki-strip-production-debug-output",
    apply: "build",
    transform(code, id) {
      const path = id.split("?")[0] ?? id;

      if (!path.includes("/src/") || !/\.[cm]?[jt]sx?$/.test(path)) {
        return null;
      }

      const stripped = code
        .replace(/\bdebugger\s*;?/g, "")
        .replace(/^\s*console\.(?:log|debug|info)\([^;\n]*(?:\n[^;]*)?\);\s*$/gm, "");

      return stripped === code ? null : { code: stripped, map: null };
    }
  };
}
