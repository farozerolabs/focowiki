import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");

describe("GraphRAG unified worker image contract", () => {
  it("includes Node, Python, GraphRAG, and Jieba in the canonical API image", () => {
    const dockerfile = read("Dockerfile");
    expect(dockerfile).toContain("FROM python:3.12-slim-bookworm AS api");
    expect(dockerfile).toContain("COPY apps/api/python/requirements.lock");
    expect(dockerfile).toContain("python -m pip install --no-cache-dir -r");
    expect(dockerfile).toContain("python -m graphrag_adapter_check");
    expect(dockerfile).toContain("apps/api/runtime/worker.mjs");
    expect(dockerfile).toContain("nodejieba");
    expect(dockerfile).not.toMatch(/AS source-worker|source-worker-entrypoint/u);
  });

  it("uses one canonical worker service and image in every template", () => {
    for (const path of [
      "docker-compose.yml.example",
      "docker-compose.dev.yml.example",
      "docker-compose.local.yml.example"
    ]) {
      const compose = read(path);
      const worker = serviceBlock(compose, "worker");
      expect(worker, path).toContain("apps/api/runtime/worker.mjs");
      expect(worker, path).toMatch(/FOCOWIKI_API_IMAGE|image: focowiki-api:dev/u);
      expect(compose, path).not.toMatch(
        /^  (?:source|publication|maintenance)-worker:/mu
      );
    }
  });

  it("publishes and validates only the canonical backend image", () => {
    const ci = read(".github/workflows/ci.yml");
    const release = read(".github/workflows/docker-build.yml");
    expect(ci).toContain("focowiki-api:ci -m graphrag_adapter_check");
    expect(ci).toContain("apps/api/runtime/worker.mjs --healthcheck");
    expect(release).toContain("apps/api/runtime/worker.mjs --healthcheck");
    expect(`${ci}\n${release}`).not.toMatch(
      /FOCOWIKI_SOURCE_WORKER_IMAGE|SOURCE_WORKER_IMAGE|target: source-worker/u
    );
  });

  it("validates release candidates before promoting public image tags", () => {
    const release = read(".github/workflows/docker-build.yml");
    const buildApi = release.indexOf("Build API candidate by digest");
    const buildAdmin = release.indexOf("Build Admin candidate by digest");
    const validateApi = release.indexOf("Validate candidate API image roles");
    const validateAdmin = release.indexOf("Validate candidate Admin image");
    const attestApi = release.indexOf("Attest API image");
    const attestAdmin = release.indexOf("Attest Admin image");
    const promote = release.indexOf("Promote validated image tags");

    expect(release).toContain("push-by-digest=true");
    expect(release).toContain("Verify successful CI for release commit");
    expect(buildApi).toBeGreaterThan(-1);
    expect(buildAdmin).toBeGreaterThan(buildApi);
    expect(validateApi).toBeGreaterThan(buildAdmin);
    expect(validateAdmin).toBeGreaterThan(validateApi);
    expect(attestApi).toBeGreaterThan(validateAdmin);
    expect(attestAdmin).toBeGreaterThan(attestApi);
    expect(promote).toBeGreaterThan(attestAdmin);
  });

  it("runs owned Redis and real S3-compatible integration contracts in CI", () => {
    const ci = read(".github/workflows/ci.yml");

    expect(ci).toContain("FOCOWIKI_STORAGE_VNEXT_TEST_REDIS_URL:");
    expect(ci).toContain("FOCOWIKI_TEST_EXTERNAL_S3: \"true\"");
    expect(ci).toContain("FOCOWIKI_TEST_S3_ENDPOINT:");
    expect(ci).toContain("Start versioned S3 compatibility fixture");
    expect(ci).toContain("minio/minio:RELEASE.2025-09-07T16-13-09Z");
    expect(ci).toContain("Stop versioned S3 compatibility fixture");
  });

  it("requires successful CI before every independently triggered release", () => {
    const dockerRelease = read(".github/workflows/docker-build.yml");
    const prerelease = read(".github/workflows/docker-prerelease.yml");
    const stable = read(".github/workflows/docker-publish.yml");
    const documentation = read(".github/workflows/docs-publish.yml");

    expect(dockerRelease).toContain("Verify successful CI for release commit");
    expect(documentation).toContain("Verify successful CI for release commit");
    for (const workflow of [dockerRelease, prerelease, stable, documentation]) {
      expect(workflow).toContain("checks: read");
    }
  });

  it("executes search initialization and the real Admin entrypoint in CI and CD", () => {
    const ci = read(".github/workflows/ci.yml");
    const release = read(".github/workflows/docker-build.yml");

    for (const workflow of [ci, release]) {
      expect(workflow).toContain("apps/api/runtime/search-init.mjs");
      expect(workflow).toContain('"source":"generated"');
      expect(workflow).toContain('"source":"reused"');
      expect(workflow).toContain("ADMIN_API_PROXY_TARGET=http://api:43000");
      expect(workflow).toContain("nginx -t");
      expect(workflow).not.toContain("--entrypoint nginx");
    }
  });
});

function read(path: string): string {
  return readFileSync(resolve(workspaceRoot, path), "utf8");
}

function serviceBlock(source: string, service: string): string {
  const marker = `\n  ${service}:\n`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Missing ${service} service.`);
  const bodyStart = start + 1;
  const remainder = source.slice(bodyStart + marker.length - 1);
  const next = remainder.search(/^  [a-z][a-z0-9-]*:\n/mu);
  return next < 0 ? source.slice(bodyStart) : source.slice(bodyStart, bodyStart
    + marker.length - 1 + next);
}
