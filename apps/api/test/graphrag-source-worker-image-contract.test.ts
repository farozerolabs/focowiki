import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");

describe("GraphRAG source-worker image contract", () => {
  it("builds a dedicated Python 3.12 runtime with the locked adapter", () => {
    const dockerfile = read("Dockerfile");

    expect(dockerfile).toContain("FROM node:24-bookworm-slim AS source-worker-dependencies");
    expect(dockerfile).toContain("FROM python:3.12-slim-bookworm AS source-worker");
    expect(dockerfile).toContain("COPY apps/api/python/requirements.lock");
    expect(dockerfile).toContain("python -m pip install --no-cache-dir -r");
    expect(dockerfile).toContain("python -m graphrag_adapter_check");
    expect(dockerfile).toContain("focowiki-source-worker-entrypoint");
    expect(dockerfile).toContain("dumb-init");
    const entrypoint = read("deploy/docker/source-worker-entrypoint.sh");
    expect(entrypoint).toContain("umask 077");
    expect(entrypoint).toContain("chmod 700 \"${runtime_secret_dir}\"");
    expect(entrypoint).toContain("gosu node:node");
  });

  it("uses the dedicated image and explicit resource ceilings in every full-stack template", () => {
    for (const path of [
      "docker-compose.yml.example",
      "docker-compose.dev.yml.example",
      "docker-compose.local.yml.example"
    ]) {
      const compose = read(path);
      const sourceWorker = serviceBlock(compose, "source-worker", "publication-worker");

      expect(sourceWorker, path).toContain("FOCOWIKI_SOURCE_WORKER_IMAGE");
      expect(sourceWorker, path).toContain("cpus: ${SOURCE_WORKER_CPUS");
      expect(sourceWorker, path).toContain("mem_limit: ${SOURCE_WORKER_MEMORY_LIMIT");
      expect(sourceWorker, path).toContain("pids_limit: ${SOURCE_WORKER_PIDS_LIMIT");
      expect(sourceWorker, path).toContain("stop_grace_period: 30s");
      expect(compose, path).not.toMatch(/^\s{2}graphrag(?:-init)?:/mu);
    }

    for (const path of ["docker-compose.dev.yml.example", "docker-compose.local.yml.example"]) {
      expect(serviceBlock(read(path), "source-worker", "publication-worker"), path)
        .toContain("target: source-worker");
    }
  });

  it("documents only operator-owned source-worker startup limits in environment templates", () => {
    for (const path of [".env.example", ".env.dev.example"]) {
      const environment = read(path);
      for (const field of [
        "FOCOWIKI_SOURCE_WORKER_IMAGE",
        "SOURCE_WORKER_CPUS",
        "SOURCE_WORKER_MEMORY_LIMIT",
        "SOURCE_WORKER_PIDS_LIMIT"
      ]) {
        expect(environment, `${path} is missing ${field}`).toContain(`${field}=`);
      }
      expect(environment, path).not.toContain("GRAPHRAG_PROMPT");
      expect(environment, path).not.toContain("GRAPHRAG_ENTITY_TYPES");
    }
  });

  it("publishes and validates the source-worker image independently", () => {
    const ci = read(".github/workflows/ci.yml");
    const release = read(".github/workflows/docker-build.yml");

    expect(ci).toContain("docker build --target source-worker");
    expect(ci).toContain("focowiki-source-worker:ci");
    expect(ci).toContain(
      "python focowiki-source-worker:ci -m unittest discover -s apps/api/python/tests -v"
    );
    expect(release).toContain("SOURCE_WORKER_IMAGE:");
    expect(release).toContain("target: source-worker");
    expect(release).toContain("steps.build-source-worker.outputs.digest");
  });
});

function read(path: string): string {
  return readFileSync(resolve(workspaceRoot, path), "utf8");
}

function serviceBlock(source: string, start: string, end: string): string {
  const match = source.match(new RegExp(
    `^  ${start}:\\n([\\s\\S]*?)(?=^  ${end}:\\n)`,
    "mu"
  ));
  if (!match?.[0]) throw new Error(`Missing ${start} service before ${end}.`);
  return match[0];
}
