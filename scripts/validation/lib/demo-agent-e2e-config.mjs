import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { randomUUID } from "node:crypto";

export const DEMO_E2E_CHANGE_ID = "validate-demo-agent-e2e";
export const DEMO_REPO_ENV = "FOCOWIKI_DEMO_E2E_DEMO_REPO";
export const START_SERVICES_ENV = "FOCOWIKI_DEMO_E2E_START_SERVICES";
export const START_FOCOWIKI_ENV = "FOCOWIKI_DEMO_E2E_START_FOCOWIKI";
export const START_DEMO_ENV = "FOCOWIKI_DEMO_E2E_START_DEMO";
export const CLEANUP_KB_ENV = "FOCOWIKI_DEMO_E2E_CLEANUP_KNOWLEDGE_BASE";
export const ENABLE_DEVELOPER_ROUTE_CHECKS_ENV = "FOCOWIKI_DEMO_E2E_ENABLE_DEVELOPER_ROUTE_CHECKS";

export function loadLocalEnv() {
  const envFile = process.env.ENV_FILE || ".env";
  if (fs.existsSync(envFile)) {
    loadEnvFile(envFile);
  }
}

export function readDemoAgentE2eConfig(env = process.env) {
  const changeDir = path.resolve("openspec/changes", DEMO_E2E_CHANGE_ID);
  const demoRepo = path.resolve(env[DEMO_REPO_ENV]?.trim() || "../focowiki-demo");
  const reportDir = path.resolve(env.FOCOWIKI_DEMO_E2E_REPORT_DIR?.trim() || changeDir);
  const demoBaseUrl = trimTrailingSlash(
    env.FOCOWIKI_DEMO_E2E_DEMO_BASE_URL?.trim() || "http://127.0.0.1:45010"
  );

  return {
    changeId: DEMO_E2E_CHANGE_ID,
    changeDir,
    reportDir,
    runtimeDir: path.join(reportDir, "runtime"),
    demoRepo,
    adminApiBaseUrl: trimTrailingSlash(
      env.FOCOWIKI_DEMO_E2E_ADMIN_API_BASE_URL?.trim() ||
        `http://127.0.0.1:${env.ADMIN_API_PORT?.trim() || "43000"}`
    ),
    adminUiBaseUrl: trimTrailingSlash(
      env.FOCOWIKI_DEMO_E2E_ADMIN_UI_BASE_URL?.trim() ||
        `http://127.0.0.1:${env.ADMIN_UI_PORT?.trim() || "43100"}`
    ),
    openApiBaseUrl: trimTrailingSlash(
      env.FOCOWIKI_DEMO_E2E_OPENAPI_BASE_URL?.trim() ||
        `http://127.0.0.1:${env.PUBLIC_OPENAPI_PORT?.trim() || "43200"}`
    ),
    adminOrigin:
      env.FOCOWIKI_DEMO_E2E_ADMIN_ORIGIN?.trim() ||
      env.ADMIN_PUBLIC_ORIGIN?.trim() ||
      "http://localhost:43100",
    demoBaseUrl,
    agentApiKey:
      env.FOCOWIKI_DEMO_E2E_AGENT_API_KEY?.trim() ||
      env.AGENT_API_KEY?.trim() ||
      `demo-agent-e2e-${randomUUID()}`,
    openApiKey:
      env.FOCOWIKI_DEMO_E2E_OPENAPI_KEY?.trim() ||
      env.FOCOWIKI_OPENAPI_KEY?.trim() ||
      env.PUBLIC_OPENAPI_KEY?.trim() ||
      "",
    adminUsername: env.ADMIN_USERNAME?.trim() || "",
    adminPassword: env.ADMIN_PASSWORD || "",
    startServices: readBoolean(env[START_SERVICES_ENV], true),
    startFocowiki: readBoolean(env[START_FOCOWIKI_ENV], readBoolean(env[START_SERVICES_ENV], true)),
    startDemo: readBoolean(env[START_DEMO_ENV], readBoolean(env[START_SERVICES_ENV], true)),
    cleanupKnowledgeBase: readBoolean(env[CLEANUP_KB_ENV], true),
    enableDeveloperRouteChecks: readBoolean(env[ENABLE_DEVELOPER_ROUTE_CHECKS_ENV], false),
    requestTimeoutMs: readPositiveInteger(env.FOCOWIKI_DEMO_E2E_REQUEST_TIMEOUT_MS, 30_000),
    serviceTimeoutMs: readPositiveInteger(env.FOCOWIKI_DEMO_E2E_SERVICE_TIMEOUT_MS, 120_000),
    taskTimeoutMs: readPositiveInteger(env.FOCOWIKI_DEMO_E2E_TASK_TIMEOUT_MS, 900_000),
    taskPollIntervalMs: readPositiveInteger(env.FOCOWIKI_DEMO_E2E_TASK_POLL_INTERVAL_MS, 2_000),
    maxRouteLimit: readPositiveInteger(env.FOCOWIKI_DEMO_E2E_MAX_ROUTE_LIMIT, 50),
    demoLogDir: path.resolve(env.FOCOWIKI_DEMO_E2E_LOG_DIR?.trim() || path.join(changeDir, "runtime/demo-logs"))
  };
}

export function validateDemoRepository(config) {
  if (!fs.existsSync(config.demoRepo) || !fs.statSync(config.demoRepo).isDirectory()) {
    throw new Error(`${DEMO_REPO_ENV} must point to the standalone demo backend repository.`);
  }

  const packageJson = path.join(config.demoRepo, "package.json");
  if (!fs.existsSync(packageJson)) {
    throw new Error(`${DEMO_REPO_ENV} must point to a Node project with package.json.`);
  }
}

export function safeConfigSummary(config) {
  return {
    demoRepo: `<${DEMO_REPO_ENV}>`,
    adminApiBaseUrl: config.adminApiBaseUrl,
    adminUiBaseUrl: config.adminUiBaseUrl,
    openApiBaseUrl: config.openApiBaseUrl,
    demoBaseUrl: config.demoBaseUrl,
    startServices: config.startServices,
    startFocowiki: config.startFocowiki,
    startDemo: config.startDemo,
    cleanupKnowledgeBase: config.cleanupKnowledgeBase,
    enableDeveloperRouteChecks: config.enableDeveloperRouteChecks,
    demoLogDir: "<runtime-demo-log-dir>"
  };
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function readBoolean(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function readPositiveInteger(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("Expected a positive integer runtime setting.");
  }
  return parsed;
}
