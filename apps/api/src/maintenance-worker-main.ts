import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { loadRuntimeConfig } from "./config.js";
import { runRuntimeDeploymentHealthcheck } from
  "./runtime/deployment-healthcheck.js";
import { assertNodeJiebaRuntimeAvailable } from
  "./infrastructure/tokenization/nodejieba-tokenizer.js";
import { runStorageVnextMaintenanceWorker } from
  "./storage-vnext/maintenance/production-runtime.js";

loadLocalEnvFile();
const config = loadRuntimeConfig();

if (process.argv.includes("--healthcheck")) {
  await runRuntimeDeploymentHealthcheck(config, {
    role: "maintenance-worker",
    ...(config.search?.provider === "opensearch"
      ? { assertTokenizer: assertNodeJiebaRuntimeAvailable }
      : {})
  });
} else {
  await runStorageVnextMaintenanceWorker(config);
}

function loadLocalEnvFile(): void {
  if (process.env.ENV_FILE) {
    loadEnvFile(process.env.ENV_FILE);
    return;
  }
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../../.env")
  ];
  const envFile = candidates.find((candidate) => existsSync(candidate));
  if (envFile) loadEnvFile(envFile);
}
