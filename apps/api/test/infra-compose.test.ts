import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const composePaths = [
  "docker-compose.yml.example",
  "docker-compose.dev.yml.example",
  "docker-compose.local.yml.example"
] as const;

describe("Docker Compose infrastructure", () => {
  it("keeps the Admin proxy resilient to API container replacement", () => {
    const nginx = read("deploy/nginx/default.conf.template");
    expect(nginx).toContain("resolver 127.0.0.11 valid=10s ipv6=off;");
    expect(nginx).toContain("set $admin_api_proxy_target ${ADMIN_API_PROXY_TARGET};");
    expect(nginx).toContain("proxy_pass $admin_api_proxy_target;");
  });

  it.each(composePaths)("uses one canonical backend worker in %s", (path) => {
    const compose = read(path);
    expect(compose).toMatch(/^  worker:\s*$/mu);
    expect(service(compose, "worker")).toContain("apps/api/runtime/worker.mjs");
    expect(service(compose, "worker")).toContain("--max-old-space-size=512");
    expect(compose).not.toMatch(
      /^  (?:source|publication|maintenance)-worker:\s*$/mu
    );
    expect(compose).not.toMatch(
      /source-worker\.mjs|publication-worker\.mjs|maintenance-worker\.mjs/u
    );
  });

  it("defines the complete local developer topology", () => {
    const compose = read("docker-compose.local.yml.example");
    for (const name of [
      "admin", "api", "worker", "search-init", "migrate", "postgres", "redis",
      "minio", "minio-init", "opensearch"
    ]) expect(compose).toMatch(new RegExp(`^  ${name}:`, "mu"));
    expect(compose).toContain("  # meilisearch:");
    expect(compose).toContain("S3_ENDPOINT: http://minio:9000");
    expect(compose).toContain('"127.0.0.1:${MEILI_PORT-57700}:7700"');
    expect(compose).toContain('"127.0.0.1:${OPENSEARCH_PORT-59200}:9200"');
  });

  it.each(composePaths)("bounds and healthchecks the unified worker in %s", (path) => {
    const worker = service(read(path), "worker");
    expect(worker).toContain("WORKER_CPUS");
    expect(worker).toContain("WORKER_MEMORY_LIMIT");
    expect(worker).toContain("WORKER_PIDS_LIMIT");
    expect(worker).toContain("apps/api/runtime/worker.mjs",);
    expect(worker).toContain("--healthcheck");
    expect(worker).toContain("stop_grace_period: 30s");
  });

  it.each(composePaths)("keeps Redis persistence bounded in %s", (path) => {
    const redis = service(read(path), "redis");
    expect(redis).toContain('"--appendonly", "yes"');
    expect(redis).toContain('"--auto-aof-rewrite-percentage", "100"');
    expect(redis).toContain('"--auto-aof-rewrite-min-size", "8mb"');
  });

  it.each(composePaths)("uses exactly one selected private search provider in %s", (path) => {
    const compose = read(path);
    expect(service(compose, "meilisearch")).toBe("");
    expect(compose).toContain('  #   profiles: ["meilisearch"]');
    expect(service(compose, "opensearch")).toContain('profiles: ["opensearch"]');
    expect(service(compose, "opensearch")).toContain(
      'DISABLE_PERFORMANCE_ANALYZER_AGENT_CLI: "true"'
    );
    expect(service(compose, "migrate")).toContain("search-init:");
  });

  it.each(composePaths)("prepares the OpenSearch bind-mounted data directory in %s", (path) => {
    const searchInit = service(read(path), "search-init");
    expect(searchInit).toContain("OPENSEARCH_DATA_DIR: /app/opensearch-data");
    expect(searchInit).toContain(
      "./data/opensearch:/app/opensearch-data"
    );
  });

  it("builds API, worker, migration, and search initialization in one image", () => {
    const dockerfile = read("Dockerfile");
    const build = read("apps/api/scripts/build-runtime.mjs");
    expect(dockerfile).toContain("FROM python:3.12-slim-bookworm AS api");
    expect(dockerfile).toContain("apps/api/runtime/worker.mjs");
    expect(build).toContain('worker: "src/worker-main.ts"');
    expect(`${dockerfile}\n${build}`).not.toMatch(
      /AS source-worker|source-worker\.mjs|publication-worker\.mjs|maintenance-worker\.mjs/u
    );
    expect(existsSync(resolve(root,
      "deploy/docker/source-worker-entrypoint.sh"))).toBe(false);
  });

  it("initializes mounted directories before dropping privileges", () => {
    const entrypoint = read("deploy/docker/api-entrypoint.sh");
    expect(entrypoint).toContain('mkdir -p "${resolved_log_dir}"');
    expect(entrypoint).toContain("chown -R node:node");
    expect(entrypoint).toContain('chmod 700 "${runtime_secret_dir}"');
    expect(entrypoint).toContain('if [ -n "${OPENSEARCH_DATA_DIR:-}" ]');
    expect(entrypoint).toContain('stat -c "%u:%g" "${OPENSEARCH_DATA_DIR}"');
    expect(entrypoint).toContain('chown -R node:node "${OPENSEARCH_DATA_DIR}"');
    expect(entrypoint).toContain('chmod 700 "${OPENSEARCH_DATA_DIR}"');
    expect(entrypoint).toContain('exec gosu node:node "$@"');
  });

  it("uses unified deployment variables without removed worker roles", () => {
    for (const path of [".env.example", ".env.dev.example"]) {
      const environment = read(path);
      for (const field of [
        "WORKER_DATABASE_POOL_MAX", "WORKER_CPUS", "WORKER_MEMORY_LIMIT",
        "WORKER_PIDS_LIMIT"
      ]) expect(environment, `${path}:${field}`).toContain(`${field}=`);
      expect(environment).not.toMatch(
        /FOCOWIKI_SOURCE_WORKER_IMAGE|SOURCE_WORKER_|PUBLICATION_WORKER_|MAINTENANCE_WORKER_/u
      );
    }
  });

  it("validates only canonical runtime artifacts in CI and release", () => {
    const workflows = `${read(".github/workflows/ci.yml")}\n${
      read(".github/workflows/docker-build.yml")}`;
    expect(workflows).toContain("apps/api/runtime/worker.mjs --healthcheck");
    expect(workflows).toContain("python focowiki-api:ci -m graphrag_adapter_check");
    expect(workflows).not.toMatch(
      /SOURCE_WORKER_IMAGE|target: source-worker|(?:source|publication|maintenance)-worker\.mjs/u
    );
  });

  it("validates OpenSearch data-directory ownership with built API images", () => {
    const ci = read(".github/workflows/ci.yml");
    const release = read(".github/workflows/docker-build.yml");
    expect(ci).toContain('OPENSEARCH_DATA_DIR=/app/opensearch-data');
    expect(ci).toContain('test -w /app/opensearch-data');
    expect(release).toContain('OPENSEARCH_DATA_DIR=/app/opensearch-data');
    expect(release).toContain('test -w /app/opensearch-data');
  });

  it("bounds documentation-browser setup and uses the stable Ubuntu archive", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain("timeout-minutes: 10");
    expect(ci).toContain("https://archive.ubuntu.com/ubuntu");
  });

  it("pins maintained infrastructure versions", () => {
    const compose = read("docker-compose.local.yml.example");
    expect(compose).toContain("postgres:18-alpine");
    expect(compose).toContain("redis:8-alpine");
    expect(compose).toContain("getmeili/meilisearch:v1.51.0");
    expect(compose).toContain("opensearchproject/opensearch:3.8.0");
  });
});

function service(source: string, name: string): string {
  const startMarker = `\n  ${name}:\n`;
  const start = source.indexOf(startMarker);
  if (start < 0) return "";
  const bodyStart = start + 1;
  const remaining = source.slice(bodyStart + startMarker.length - 1);
  const next = remaining.search(/^  [a-z][a-z0-9-]*:\n/mu);
  return next < 0 ? source.slice(bodyStart) : source.slice(
    bodyStart,
    bodyStart + startMarker.length - 1 + next
  );
}
