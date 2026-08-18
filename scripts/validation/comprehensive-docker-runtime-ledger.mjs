#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { reconcileComprehensiveDockerRuntime } from
  "./lib/comprehensive-docker-runtime-ledger.mjs";

const project = requiredEnv("FOCOWIKI_COMPREHENSIVE_COMPOSE_PROJECT");
if (!/^focowiki-clr-[a-z0-9-]+$/u.test(project)) {
  throw new Error("Comprehensive Docker project is not validation-owned");
}
const envFile = requiredEnv("FOCOWIKI_COMPREHENSIVE_COMPOSE_ENV_FILE");
const composeFiles = requiredEnv("FOCOWIKI_COMPREHENSIVE_COMPOSE_FILES")
  .split(",").map((value) => value.trim()).filter(Boolean);
const selectedProfile = requiredEnv("FOCOWIKI_COMPREHENSIVE_COMPOSE_PROFILE");
const reportPath = path.resolve(requiredEnv("FOCOWIKI_COMPREHENSIVE_DOCKER_REPORT"));
if (composeFiles.length < 1 || composeFiles.some((value) => !fs.existsSync(value))) {
  throw new Error("Comprehensive Docker Compose files are invalid");
}

const composeArgs = ["compose", "--env-file", envFile, "-p", project];
for (const file of composeFiles) composeArgs.push("-f", file);
composeArgs.push("--profile", selectedProfile);

const expectedActiveServices = lines(docker([...composeArgs, "config", "--services"]));
const profiles = lines(docker([...composeArgs, "config", "--profiles"]));
if (!profiles.includes(selectedProfile)) {
  throw new Error("Comprehensive Docker selected profile is absent from Compose");
}
const ONE_SHOT_SERVICES = ["migrate", "minio-init", "search-init"]
  .filter((service) => expectedActiveServices.includes(service));
const APP_RUNTIME_SERVICES = [
  "api",
  "worker",
  "worker",
  "worker"
].filter((service) => expectedActiveServices.includes(service));
const psRows = lines(docker([...composeArgs, "ps", "--all", "--format", "json"]))
  .map((line) => JSON.parse(line));
const inspections = psRows.map((row) => {
  const inspected = JSON.parse(docker(["inspect", row.ID]))[0];
  const service = inspected.Config?.Labels?.["com.docker.compose.service"];
  const state = inspected.State?.Status;
  return {
    service,
    state,
    health: inspected.State?.Health?.Status ?? null,
    exitCode: Number(inspected.State?.ExitCode ?? 0),
    restartCount: Number(inspected.RestartCount ?? 0),
    privileged: inspected.HostConfig?.Privileged === true,
    readOnlyRootfs: inspected.HostConfig?.ReadonlyRootfs === true,
    capAdd: inspected.HostConfig?.CapAdd ?? [],
    nanoCpus: Number(inspected.HostConfig?.NanoCpus ?? 0),
    memoryBytes: Number(inspected.HostConfig?.Memory ?? 0),
    pidsLimit: inspected.HostConfig?.PidsLimit ?? null,
    runtimeUid: state === "running" && APP_RUNTIME_SERVICES.includes(service)
      ? applicationRuntimeUid(inspected.Id)
      : null,
    publishedPorts: Object.entries(inspected.HostConfig?.PortBindings ?? {})
      .flatMap(([containerPort, bindings]) => (bindings ?? []).map((binding) => ({
        hostIp: binding.HostIp ?? "",
        hostPort: binding.HostPort ?? "",
        containerPort
      }))),
    mounts: (inspected.Mounts ?? []).map((mount) => ({
      type: mount.Type,
      destination: mount.Destination,
      readOnly: mount.RW === false
    })).sort((left, right) => left.destination.localeCompare(right.destination, "en")),
    environmentNames: (inspected.Config?.Env ?? []).map((value) =>
      String(value).split("=", 1)[0]).sort(),
    imageId: inspected.Image
  };
});

const inactiveProvider = selectedProfile === "meilisearch" ? "opensearch" : "meilisearch";
const reconciliation = reconcileComprehensiveDockerRuntime({
  selectedProfile,
  expectedActiveServices,
  oneShotServices: ONE_SHOT_SERVICES,
  appRuntimeServices: APP_RUNTIME_SERVICES,
  resourceLimitedServices: expectedActiveServices.includes("worker")
    ? ["worker"] : [],
  allowedInactiveServices: psRows.some((row) => row.Service === inactiveProvider)
    ? [inactiveProvider] : [],
  containers: inspections
});
const report = {
  format: "focowiki-comprehensive-docker-runtime-ledger-v1",
  generatedAt: new Date().toISOString(),
  project,
  composeFiles: composeFiles.map((file) => path.basename(file)),
  profiles,
  ...reconciliation
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(reportPath, 0o600);
process.stdout.write(`${JSON.stringify({
  ok: report.ok,
  reportPath,
  selectedProfile,
  counts: report.counts
})}\n`);

function docker(args) {
  return execFileSync("docker", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      SEARCH_PROVIDER: selectedProfile,
      COMPOSE_PROFILES: selectedProfile
    },
    maxBuffer: 16 * 1024 * 1024
  });
}

function lines(value) {
  return value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

function applicationRuntimeUid(containerId) {
  const process = lines(docker([
    "top",
    containerId,
    "-eo",
    "pid,user,comm,args"
  ])).slice(1).find((line) => {
    const uid = Number(line.split(/\s+/u)[1]);
    return Number.isSafeInteger(uid) && uid > 0
      && /\bnode\b/u.test(line)
      && /apps\/api\/runtime\/[a-z-]+\.mjs/u.test(line);
  });
  const user = process?.split(/\s+/u)[1];
  const uid = Number(user);
  if (!Number.isSafeInteger(uid)) {
    throw new Error("Comprehensive Docker app runtime UID is unavailable");
  }
  return uid;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
