import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  createRuntimeServiceSupervisor,
  RUNTIME_SERVICE_ORDER
} from "./interleaved-runtime-services.mjs";
import {
  combineOkfV02ResourceSnapshots,
  parseOkfV02ContainerResourceSnapshot,
  parseOkfV02ProcessResourceSnapshot
} from "./okf-v02-runtime-observations.mjs";

const execFileAsync = promisify(execFile);

export function createOkfV02RuntimeProjectName(runId) {
  const suffix = createHash("sha256").update(String(runId)).digest("hex").slice(0, 16);
  return `focowikiokfv02${suffix}`;
}

export function assertOkfV02RuntimeServicesRunning(supervisor) {
  for (const serviceName of RUNTIME_SERVICE_ORDER) {
    if (supervisor?.isRunning(serviceName)) continue;
    const exit = supervisor?.exitState(serviceName);
    const detail = exit
      ? `code=${exit.code ?? "null"}, signal=${exit.signal ?? "null"}`
      : "exit state unavailable";
    throw new Error(`Runtime service exited: ${serviceName} (${detail}).`);
  }
  return true;
}

export function createOkfV02RuntimeEnvironment(baseEnv, provider, logDirectory) {
  if (provider !== "meilisearch" && provider !== "opensearch") {
    throw new Error("The OKF 0.2 E2E search provider is invalid.");
  }
  const postgresPort = baseEnv.POSTGRES_PORT || "55432";
  const redisPort = baseEnv.REDIS_PORT || "56379";
  const s3Port = baseEnv.S3_PORT || "43300";
  const meiliPort = baseEnv.MEILI_PORT || "57700";
  const openSearchPort = baseEnv.OPENSEARCH_PORT || "59200";
  const runNamespace = createHash("sha256")
    .update(path.dirname(String(logDirectory)))
    .digest("hex")
    .slice(0, 12);
  return {
    ...baseEnv,
    APP_ENV: "development",
    LOG_FILE_DIR: path.resolve(logDirectory),
    POSTGRES_DB: "focowiki_e2e",
    POSTGRES_USER: "focowiki_e2e",
    POSTGRES_PASSWORD: "focowiki-e2e-postgres",
    DATABASE_URL:
      `postgres://focowiki_e2e:focowiki-e2e-postgres@127.0.0.1:${postgresPort}/focowiki_e2e`,
    REDIS_URL: `redis://127.0.0.1:${redisPort}/0`,
    S3_ENDPOINT: `http://127.0.0.1:${s3Port}`,
    S3_REGION: "local",
    S3_BUCKET: `focowiki-e2e-${runNamespace}`,
    S3_ACCESS_KEY_ID: "focowiki-e2e",
    S3_SECRET_ACCESS_KEY: "focowiki-e2e-minio-secret",
    S3_FORCE_PATH_STYLE: "true",
    SEARCH_PROVIDER: provider,
    SEARCH_INDEX_PREFIX: `focowiki_e2e_${runNamespace}`,
    COMPOSE_PROFILES: provider,
    MEILI_HOST: `http://127.0.0.1:${meiliPort}`,
    MEILI_API_KEY: baseEnv.MEILI_API_KEY || baseEnv.MEILI_MASTER_KEY,
    MEILI_METRICS_API_KEY:
      baseEnv.MEILI_METRICS_API_KEY || baseEnv.MEILI_MASTER_KEY,
    OPENSEARCH_URL: `http://127.0.0.1:${openSearchPort}`,
    OPENSEARCH_AUTH_MODE: "none",
    OPENSEARCH_CA_FILE: "",
    OPENSEARCH_USERNAME: "",
    OPENSEARCH_PASSWORD: "",
    OPENSEARCH_PASSWORD_FILE: "",
    REDIS_KEY_PREFIX: `okf-v02:${runNamespace}`,
    S3_PREFIX: `okf-v02/${runNamespace}`
  };
}

export function createOkfV02RuntimeInfrastructure(input) {
  const projectName = createOkfV02RuntimeProjectName(input.workspace.runId);
  const composeBase = [
    "compose",
    "-p",
    projectName,
    "-f",
    "docker-compose.local.yml"
  ];
  const runCommand = input.runCommand ?? runExternalCommand;
  const supervisorFactory = input.supervisorFactory ?? createRuntimeServiceSupervisor;
  const logRoot = path.join(input.workspace.root, "runtime-logs");
  let provider = null;
  let runtimeEnv = null;
  let supervisor = null;
  let cleaned = false;

  return {
    projectName,
    get provider() {
      return provider;
    },
    get env() {
      return runtimeEnv;
    },
    async start(providerName = "meilisearch") {
      if (provider) throw new Error("The OKF 0.2 E2E infrastructure is already started.");
      runtimeEnv = createOkfV02RuntimeEnvironment(
        input.env,
        providerName,
        path.join(logRoot, providerName)
      );
      const existing = await runCommand("docker", [...composeBase, "ps", "-q"], runtimeEnv);
      if (String(existing).trim()) {
        throw new Error("The run-owned Compose project was not empty before startup.");
      }
      await composeUp(providerName);
      await runCommand(process.execPath, [
        "--import",
        "tsx",
        "apps/api/src/db/migrate.ts"
      ], runtimeEnv);
      await runCommand(process.execPath, [
        "apps/api/scripts/build-runtime.mjs"
      ], runtimeEnv);
      provider = providerName;
      await startApplications();
      await waitForHttp(
        `http://127.0.0.1:${runtimeEnv.ADMIN_API_PORT || "43000"}/healthz`,
        60_000
      );
      await waitForHttp(
        `http://127.0.0.1:${runtimeEnv.PUBLIC_OPENAPI_PORT || "43200"}/healthz`,
        60_000
      );
    },
    async switchProvider(nextProvider) {
      if (!provider || !runtimeEnv) {
        throw new Error("The OKF 0.2 E2E infrastructure is not started.");
      }
      if (nextProvider === provider) return;
      await stopApplications();
      await runCommand("docker", [...composeBase, "stop", provider], runtimeEnv);
      runtimeEnv = createOkfV02RuntimeEnvironment(
        input.env,
        nextProvider,
        path.join(logRoot, nextProvider)
      );
      await composeUp(nextProvider);
      provider = nextProvider;
      await startApplications();
      await waitForHttp(
        `http://127.0.0.1:${runtimeEnv.PUBLIC_OPENAPI_PORT || "43200"}/healthz`,
        60_000
      );
    },
    async stopApplications() {
      await stopApplications();
    },
    async readFailureSummary() {
      return readOkfV02RuntimeFailureSummary(logRoot);
    },
    async captureResourceSnapshot() {
      if (!runtimeEnv || !supervisor) {
        throw new Error("The OKF 0.2 E2E runtime is not available for observation.");
      }
      const [processOutput, containerIdsOutput] = await Promise.all([
        runCommand("ps", ["-ax", "-o", "%cpu=,rss=,command="], runtimeEnv),
        runCommand("docker", [...composeBase, "ps", "-q"], runtimeEnv)
      ]);
      const containerIds = String(containerIdsOutput).trim().split(/\s+/u).filter(Boolean);
      const containerOutput = containerIds.length === 0
        ? ""
        : await runCommand("docker", [
            "stats",
            "--no-stream",
            "--format",
            "{{.CPUPerc}} {{.MemUsage}}",
            ...containerIds
          ], runtimeEnv);
      return combineOkfV02ResourceSnapshots(
        parseOkfV02ProcessResourceSnapshot(processOutput),
        parseOkfV02ContainerResourceSnapshot(containerOutput)
      );
    },
    assertApplicationsRunning() {
      return assertOkfV02RuntimeServicesRunning(supervisor);
    },
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      await stopApplications();
      if (runtimeEnv) {
        await runCommand("docker", [
          ...composeBase,
          "--profile",
          "meilisearch",
          "--profile",
          "opensearch",
          "down",
          "--volumes",
          "--remove-orphans",
          "--rmi",
          "local"
        ], runtimeEnv);
      }
      provider = null;
    }
  };

  async function composeUp(providerName) {
    await runCommand("docker", [
      ...composeBase,
      "--profile",
      providerName,
      "up",
      "-d",
      "--wait",
      "postgres",
      "redis",
      "minio",
      providerName
    ], runtimeEnv);
    await runCommand("docker", [
      ...composeBase,
      "run",
      "--rm",
      "--no-deps",
      "minio-init"
    ], runtimeEnv);
  }

  async function startApplications() {
    supervisor = supervisorFactory({
      runtimeRoot: path.resolve("apps/api/runtime"),
      evidenceDir: path.join(logRoot, provider),
      cwd: process.cwd(),
      env: runtimeEnv
    });
    await supervisor.startAll();
  }

  async function stopApplications() {
    if (!supervisor) return;
    await supervisor.stopAll();
    supervisor = null;
  }
}

export async function readOkfV02RuntimeFailureSummary(logRoot) {
  const summaries = [];
  for (const providerName of ["meilisearch", "opensearch"]) {
    for (const serviceName of [
      "api", "source-worker", "publication-worker", "maintenance-worker"
    ]) {
      for (const fileName of [
        `${serviceName}.log`,
        `focowiki-${serviceName}.log`
      ]) {
        const logPath = path.join(logRoot, providerName, fileName);
        let content;
        try {
          content = await fs.readFile(logPath, "utf8");
        } catch (error) {
          if (error?.code === "ENOENT") continue;
          throw error;
        }
        for (const line of content.trim().split("\n").slice(-500)) {
          try {
            const event = JSON.parse(line);
            if (event.level !== "error") continue;
            summaries.push({
              provider: providerName,
              service: serviceName,
              event: boundedText(event.event),
              failureCode: boundedText(event.fields?.failureCode),
              errorClass: boundedText(event.fields?.errorClass),
              errorMessage: boundedText(event.fields?.errorMessage)
            });
          } catch {
            // Runtime logs are normally structured JSON; unrelated lines are ignored.
          }
        }
      }
    }
  }
  return summaries.slice(-10);
}

function boundedText(value) {
  if (typeof value !== "string") return null;
  return value
    .replace(/\/(?:Users|private|tmp)\/\S+/gu, "<REDACTED_PATH>")
    .slice(0, 500);
}

async function runExternalCommand(command, args, env) {
  const { stdout } = await execFileAsync(command, args, {
    cwd: process.cwd(),
    env,
    maxBuffer: 64 * 1024 * 1024
  });
  return stdout;
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // Startup polling is bounded by the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("The OKF 0.2 E2E runtime did not become ready.");
}
