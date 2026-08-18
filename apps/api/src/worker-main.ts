import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { loadRuntimeConfig } from "./config.js";
import { assertNodeJiebaRuntimeAvailable } from
  "./infrastructure/tokenization/nodejieba-tokenizer.js";
import { runRuntimeDeploymentHealthcheck } from
  "./runtime/deployment-healthcheck.js";
import { assertSupportedRuntimeRole } from
  "./runtime/runtime-role-contract.js";
import { runUnifiedWorkerProduction } from
  "./document-indexing/infrastructure/production-runtime.js";

loadLocalEnvFile();
assertSupportedRuntimeRole("worker");
const config = loadRuntimeConfig();

if (process.argv.includes("--healthcheck")) {
  await runRuntimeDeploymentHealthcheck(config, {
    role: "worker",
    assertTokenizer: assertNodeJiebaRuntimeAvailable
  });
} else {
  await runUnifiedWorkerProduction(config);
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
