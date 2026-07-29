import { createRequire } from "node:module";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = resolve(apiRoot, "runtime");
const require = createRequire(import.meta.url);

function resolvePackageRoot(packageName) {
  return dirname(require.resolve(`${packageName}/package.json`, { paths: [apiRoot] }));
}

await rm(runtimeDir, { force: true, recursive: true });

await build({
  absWorkingDir: apiRoot,
  banner: {
    js: "import { createRequire as __focowikiCreateRequire } from 'node:module'; const require = __focowikiCreateRequire(import.meta.url);"
  },
  bundle: true,
  external: ["nodejieba"],
  entryNames: "[name]",
  entryPoints: {
    main: "src/main.ts",
    migrate: "src/db/migrate.ts",
    "migration-preflight": "src/db/migration-preflight-main.ts",
    "meilisearch-bootstrap": "src/meilisearch-bootstrap-main.ts",
    "source-worker": "src/source-worker-main.ts",
    "publication-worker": "src/publication-worker-main.ts",
    "projection-repair-worker": "src/projection-repair-worker-main.ts",
    "lexical-rebuild-worker": "src/lexical-rebuild-worker-main.ts",
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

const nodeJiebaPackageRoot = resolvePackageRoot("nodejieba");
const nodeJiebaRuntimeRoot = resolve(runtimeDir, "node_modules/nodejieba");
const nodeJiebaRuntimeFiles = [
  "LICENSE",
  "index.js",
  "package.json",
  "build/Release/nodejieba.node",
  "submodules/cppjieba/dict/hmm_model.utf8",
  "submodules/cppjieba/dict/idf.utf8",
  "submodules/cppjieba/dict/jieba.dict.utf8",
  "submodules/cppjieba/dict/stop_words.utf8",
  "submodules/cppjieba/dict/user.dict.utf8"
];
for (const relativePath of nodeJiebaRuntimeFiles) {
  const target = resolve(nodeJiebaRuntimeRoot, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await cp(resolve(nodeJiebaPackageRoot, relativePath), target);
}

const publicationRuntime = await readFile(
  resolve(runtimeDir, "publication-worker.mjs"),
  "utf8"
);
if (publicationRuntime.includes("nodejieba")) {
  throw new Error("Publication worker must not load the native tokenizer");
}
