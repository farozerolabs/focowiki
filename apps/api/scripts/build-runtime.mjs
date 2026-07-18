import { cp, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = resolve(apiRoot, "runtime");

await rm(runtimeDir, { force: true, recursive: true });

await build({
  absWorkingDir: apiRoot,
  banner: {
    js: "import { createRequire as __focowikiCreateRequire } from 'node:module'; const require = __focowikiCreateRequire(import.meta.url);"
  },
  bundle: true,
  entryNames: "[name]",
  entryPoints: {
    main: "src/main.ts",
    migrate: "src/db/migrate.ts",
    "source-worker": "src/source-worker-main.ts",
    "publication-worker": "src/publication-worker-main.ts",
    "maintenance-worker": "src/maintenance-worker-main.ts"
  },
  format: "esm",
  legalComments: "none",
  logLevel: "info",
  outExtension: {
    ".js": ".mjs"
  },
  outdir: runtimeDir,
  platform: "node",
  sourcemap: false,
  target: "node24"
});

await cp(resolve(apiRoot, "migrations"), resolve(runtimeDir, "migrations"), {
  recursive: true
});
