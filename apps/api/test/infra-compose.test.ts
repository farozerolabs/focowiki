import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const rootDir = resolve(import.meta.dirname, "../../..");
const devComposeTemplatePath = resolve(rootDir, "docker-compose.dev.yml.example");
const localComposeTemplatePath = resolve(rootDir, "docker-compose.local.yml.example");
const deploymentComposeTemplatePath = resolve(rootDir, "docker-compose.yml.example");
const dockerfilePath = resolve(rootDir, "Dockerfile");
const dockerignorePath = resolve(rootDir, ".dockerignore");
const gitignorePath = resolve(rootDir, ".gitignore");
const packageJsonPath = resolve(rootDir, "package.json");
const devEnvTemplatePath = resolve(rootDir, ".env.dev.example");
const deploymentEnvTemplatePath = resolve(rootDir, ".env.example");
const ciWorkflowPath = resolve(rootDir, ".github/workflows/ci.yml");
const dockerPublishWorkflowPath = resolve(rootDir, ".github/workflows/docker-publish.yml");
const docsPublishWorkflowPath = resolve(rootDir, ".github/workflows/docs-publish.yml");
const docsCnamePath = resolve(rootDir, "docs/public/CNAME");

describe("Docker Compose infrastructure", () => {
  it("defines PostgreSQL and Redis services for local development in the local template", () => {
    const compose = readFileSync(localComposeTemplatePath, "utf8");

    expect(compose).toContain("postgres:");
    expect(compose).toContain("image: postgres:18-alpine");
    expect(compose).toContain("pg_isready");
    expect(compose).toContain("postgres-data:");
    expect(compose).toContain("redis:");
    expect(compose).toContain("image: redis:8-alpine");
    expect(compose).toContain("redis-cli");
    expect(compose).toContain("redis-data:");
    expect(compose).toContain("x-docker-logging: &docker-logging");
    expect(compose).toContain('max-size: "50m"');
    expect(compose).toContain('max-file: "3"');
    expect(compose.match(/logging: \*docker-logging/g)).toHaveLength(2);
    expect(compose).not.toContain("api:");
    expect(compose).not.toContain("admin:");
    expect(compose).not.toContain("migrate:");
    expect(compose).not.toMatch(/\$\{[A-Z][A-Z0-9_]*:-/);
  });

  it("does not define embedded or in-process infrastructure fallbacks", () => {
    const compose = readFileSync(localComposeTemplatePath, "utf8");

    expect(compose).not.toMatch(/sqlite|embedded|in-memory|memory-backed/i);
  });

  it("defines the Docker development stack with local build targets", () => {
    const compose = readFileSync(devComposeTemplatePath, "utf8");

    for (const service of ["admin:", "api:", "worker:", "migrate:", "postgres:", "redis:"]) {
      expect(compose).toContain(service);
    }

    expect(compose).toContain("image: focowiki-api:dev");
    expect(compose).toContain("image: focowiki-admin:dev");
    expect(compose).toContain("target: api");
    expect(compose).toContain("target: admin");
    expect(compose).toContain("apps/api/runtime/migrate.mjs");
    expect(compose).toContain("apps/api/runtime/worker.mjs");
    expect(compose).toContain("--healthcheck");
    expect(compose).toContain("stop_grace_period: ${WORKER_SHUTDOWN_GRACE_MS:?Set WORKER_SHUTDOWN_GRACE_MS in .env}ms");
    expect(compose).toContain("x-docker-logging: &docker-logging");
    expect(compose).toContain('max-size: "50m"');
    expect(compose).toContain('max-file: "3"');
    expect(compose).toContain("${LOG_FILE_HOST_DIR:?Set LOG_FILE_HOST_DIR in .env}:/app/logs");
    expect(compose.match(/logging: \*docker-logging/g)).toHaveLength(6);
    expect(compose).not.toMatch(/ghcr\.io\/farozerolabs\/focowiki-/);
  });

  it("defines the deployment stack as a committed GHCR Compose template", () => {
    const compose = readFileSync(deploymentComposeTemplatePath, "utf8");

    for (const service of ["admin:", "api:", "worker:", "migrate:", "postgres:", "redis:"]) {
      expect(compose).toContain(service);
    }

    expect(compose).toContain("${FOCOWIKI_API_IMAGE:-ghcr.io/farozerolabs/focowiki-api:latest}");
    expect(compose).toContain("${FOCOWIKI_ADMIN_IMAGE:-ghcr.io/farozerolabs/focowiki-admin:latest}");
    expect(compose).not.toContain("target: api");
    expect(compose).not.toContain("target: admin");
    expect(compose).not.toContain("build:");
    expect(compose).toContain("apps/api/runtime/migrate.mjs");
    expect(compose).toContain("apps/api/runtime/worker.mjs");
    expect(compose).toContain("--healthcheck");
    expect(compose).toContain("stop_grace_period: ${WORKER_SHUTDOWN_GRACE_MS:?Set WORKER_SHUTDOWN_GRACE_MS in .env}ms");
    expect(compose).toContain("${ADMIN_UI_PORT:?Set ADMIN_UI_PORT in .env}:8080");
    expect(compose).toContain("${ADMIN_API_PORT:?Set ADMIN_API_PORT in .env}:${ADMIN_API_PORT:?Set ADMIN_API_PORT in .env}");
    expect(compose).toContain(
      "${PUBLIC_OPENAPI_PORT:?Set PUBLIC_OPENAPI_PORT in .env}:${PUBLIC_OPENAPI_PORT:?Set PUBLIC_OPENAPI_PORT in .env}"
    );
    expect(compose).toContain("postgres-data:");
    expect(compose).toContain("redis-data:");
    expect(compose).toContain("depends_on:");
    expect(compose).toContain("condition: service_healthy");
    expect(compose).toContain("env_file:");
    expect(compose).toContain("- .env");
    expect(compose).toContain("x-docker-logging: &docker-logging");
    expect(compose).toContain('max-size: "50m"');
    expect(compose).toContain('max-file: "3"');
    expect(compose).toContain("${LOG_FILE_HOST_DIR:?Set LOG_FILE_HOST_DIR in .env}:/app/logs");
    expect(compose.match(/logging: \*docker-logging/g)).toHaveLength(6);
    expect(compose).not.toContain("x-api-environment");
    expect(compose).not.toContain("S3_ENDPOINT:");
    expect(compose).not.toMatch(/(^|\n)\s+s3:|(^|\n)\s+s3-init:|minio|minio\/mc|s3-data:/i);
    expect(compose).not.toMatch(/sqlite|embedded|in-memory|memory-backed/i);
  });

  it("keeps Compose health checks on health-state-only probes", () => {
    const deploymentCompose = readFileSync(deploymentComposeTemplatePath, "utf8");
    const devCompose = readFileSync(devComposeTemplatePath, "utf8");

    for (const compose of [deploymentCompose, devCompose]) {
      expect(compose).toContain("http://127.0.0.1:8080/healthz");
      expect(compose).toContain("apps/api/runtime/worker.mjs\", \"--healthcheck");
      expect(compose).toContain("'/healthz'");
      expect(compose).toContain("body?.status==='ok'");
      expect(compose).not.toContain("/admin/api/session");
      expect(compose).not.toContain("/openapi/v1/version");
      expect(compose).not.toContain("/openapi/v1/openapi.json");
      expect(compose).not.toContain("apiVersion");
      expect(compose).not.toContain("authenticated");
    }
  });

  it("defines multi-stage Docker runtime targets without using the Vite dev server", () => {
    const dockerfile = readFileSync(dockerfilePath, "utf8");

    expect(dockerfile).toContain("AS dependencies");
    expect(dockerfile).toContain("AS build");
    expect(dockerfile).toContain("AS api");
    expect(dockerfile).toContain("AS admin");
    expect(dockerfile).toContain("pnpm build");
    expect(dockerfile).toContain("pnpm --filter @focowiki/api build:runtime");
    expect(dockerfile).toContain("node");
    expect(dockerfile).toContain("apk add --no-cache su-exec");
    expect(dockerfile).toContain("deploy/docker/api-entrypoint.sh");
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/local/bin/focowiki-api-entrypoint"]');
    expect(dockerfile).toContain("apps/api/runtime/main.mjs");
    expect(dockerfile).toContain("apps/api/runtime/worker.mjs");
    expect(dockerfile).toContain("apps/api/runtime/migrations");
    expect(dockerfile).not.toMatch(/pnpm\s+--filter\s+@focowiki\/admin\s+dev|vite\s+--host|pnpm\s+dev/);
  });

  it("validates worker runtime artifacts in CI", () => {
    const workflow = readFileSync(ciWorkflowPath, "utf8");

    expect(workflow).toContain("Validate API Docker worker runtime");
    expect(workflow).toContain("apps/api/runtime/worker.mjs");
    expect(workflow).toContain("apps/api/runtime/migrate.mjs");
    expect(workflow).toContain("apps/api/runtime/main.mjs");
  });

  it("keeps the API runtime image free from copied workspace node_modules", () => {
    const dockerfile = readFileSync(dockerfilePath, "utf8");
    const apiRuntime = dockerfile.split("FROM node:24-alpine AS api")[1]?.split("FROM nginx:1.29-alpine AS admin")[0] ?? "";

    expect(apiRuntime).not.toContain("node_modules");
    expect(apiRuntime).not.toContain("production-dependencies");
    expect(apiRuntime).toContain("apps/api/runtime");
    expect(apiRuntime).toContain("focowiki-api-entrypoint");
  });

  it("initializes mounted API log directories before dropping privileges", () => {
    const entrypointPath = resolve(rootDir, "deploy/docker/api-entrypoint.sh");
    const entrypoint = readFileSync(entrypointPath, "utf8");

    expect(entrypoint).toContain("LOG_FILE_DIR");
    expect(entrypoint).toContain("mkdir -p");
    expect(entrypoint).toContain("chown -R node:node");
    expect(entrypoint).toContain("exec su-exec node:node");
  });

  it("excludes local-only files from the Docker build context", () => {
    const dockerignore = readFileSync(dockerignorePath, "utf8");

    for (const pattern of [
      ".env",
      ".env.*",
      "!.env.example",
      "!.env.dev.example",
      "docker-compose.yml",
      "docker-compose.dev.yml",
      "docker-compose.local.yml",
      "node_modules",
      ".git",
      "openspec",
      "ReferenceDocs",
      "tmp",
      "dist"
    ]) {
      expect(dockerignore).toContain(pattern);
    }
  });

  it("keeps real Compose files local while publishing only templates", () => {
    const gitignore = readFileSync(gitignorePath, "utf8");

    expect(gitignore).toContain("docker-compose.yml");
    expect(gitignore).toContain("docker-compose.dev.yml");
    expect(gitignore).toContain("docker-compose.local.yml");
    expect(existsSync(deploymentComposeTemplatePath)).toBe(true);
    expect(existsSync(devComposeTemplatePath)).toBe(true);
    expect(existsSync(localComposeTemplatePath)).toBe(true);
  });

  it("defines explicit Compose cleanup scripts for local leftovers", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["compose:clean"]).toBe(
      "docker compose -f docker-compose.yml down --volumes --remove-orphans --rmi all"
    );
    expect(packageJson.scripts?.["compose:dev:clean"]).toBe(
      "docker compose -f docker-compose.dev.yml down --volumes --remove-orphans --rmi all"
    );
    expect(packageJson.scripts?.["compose:local:clean"]).toBe(
      "docker compose -f docker-compose.local.yml down --volumes --remove-orphans"
    );
  });

  it("documents separate dev and deployment environment templates", () => {
    const devEnv = readFileSync(devEnvTemplatePath, "utf8");
    const deploymentEnv = readFileSync(deploymentEnvTemplatePath, "utf8");

    expect(devEnv).toContain("APP_ENV=development");
    expect(devEnv).toContain("LOG_LEVEL=debug");
    expect(devEnv).toContain("LOG_FILE_DIR=logs");
    expect(devEnv).toContain("LOG_FILE_MAX_BYTES=10485760");
    expect(devEnv).toContain("LOG_FILE_MAX_FILES=5");
    expect(devEnv).toContain("LOG_FILE_HOST_DIR=./logs");
    expect(devEnv).not.toContain("DOCKER_LOG_MAX_SIZE");
    expect(devEnv).not.toContain("DOCKER_LOG_MAX_FILE");
    expect(devEnv).toContain("DATABASE_URL=postgres://focowiki:focowiki@127.0.0.1:55432/focowiki");
    expect(deploymentEnv).toContain("APP_ENV=production");
    expect(deploymentEnv).toContain("LOG_LEVEL=info");
    expect(deploymentEnv).toContain("LOG_FILE_DIR=logs");
    expect(deploymentEnv).toContain("LOG_FILE_MAX_BYTES=10485760");
    expect(deploymentEnv).toContain("LOG_FILE_MAX_FILES=5");
    expect(deploymentEnv).toContain("LOG_FILE_HOST_DIR=./logs");
    expect(deploymentEnv).not.toContain("DOCKER_LOG_MAX_SIZE");
    expect(deploymentEnv).not.toContain("DOCKER_LOG_MAX_FILE");
    expect(deploymentEnv).toContain("DATABASE_URL=postgres://");
    expect(deploymentEnv).toContain("REDIS_URL=redis://redis:6379/0");
    expect(deploymentEnv).toContain("S3_ENDPOINT=https://s3.example.com");
    expect(deploymentEnv).toContain("FOCOWIKI_API_IMAGE=ghcr.io/farozerolabs/focowiki-api:latest");
    expect(deploymentEnv).toContain("FOCOWIKI_ADMIN_IMAGE=ghcr.io/farozerolabs/focowiki-admin:latest");
    expect(deploymentEnv).toContain("ADMIN_SESSION_SECRET=<generate-a-strong-session-secret>");
    expect(deploymentEnv).not.toContain("ADMIN_PASSWORD=change-me");
    expect(devEnv).not.toContain("PUBLIC_API_KEY");
    expect(devEnv).not.toContain("PUBLIC_API_AUTH_REQUIRED");
    expect(deploymentEnv).not.toContain("PUBLIC_API_KEY");
    expect(deploymentEnv).not.toContain("PUBLIC_API_AUTH_REQUIRED");
  });

  it("publishes Docker images from version tags with versioned and latest tags", () => {
    const workflow = readFileSync(dockerPublishWorkflowPath, "utf8");

    expect(workflow).toContain('tags:\n      - "v*"');
    expect(workflow).not.toContain("branches:\n      - main");
    expect(workflow).toContain("group: docker-${{ github.ref }}");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("name: Resolve release version");
    expect(workflow).toContain("^v[0-9]+\\.[0-9]+\\.[0-9]+$");
    expect(workflow).toContain("Docker image releases require a semantic version tag like v1.2.3.");
    expect(workflow).toContain("name: Validate release contracts");
    expect(workflow).toContain("FOCOWIKI_RELEASE_VERSION: ${{ steps.release.outputs.version }}");
    expect(workflow).toContain("pnpm test:validation");
    expect(workflow).toContain("pnpm openapi:validate");
    expect(workflow).toContain("org.opencontainers.image.version=${{ steps.release.outputs.version }}");
    expect(workflow).toContain(
      "type=ref,event=branch,enable=${{ github.event_name == 'workflow_dispatch' && github.ref_type == 'branch' }}"
    );
    expect(workflow).toContain("type=ref,event=tag");
    expect(workflow).toContain("type=semver,pattern={{version}}");
    expect(workflow).toContain("type=semver,pattern={{major}}.{{minor}}");
    expect(workflow).toContain("type=semver,pattern={{major}}");
    expect(workflow).toContain("type=sha,prefix=sha-");
    expect(workflow).toContain("type=raw,value=latest,enable=${{ steps.release.outputs.is_release_tag == 'true' }}");
    expect(workflow).toContain("actions/attest-build-provenance@v4.1.0");
    expect(workflow).toContain("push-to-registry: true");
  });

  it("publishes documentation from version tags with release version and custom domain", () => {
    const workflow = readFileSync(docsPublishWorkflowPath, "utf8");
    const cname = readFileSync(docsCnamePath, "utf8").trim();

    expect(workflow).toContain('tags:\n      - "v*"');
    expect(workflow).not.toContain("branches:\n      - main");
    expect(workflow).toContain("group: pages");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("Documentation deployment requires a release tag.");
    expect(workflow).toContain("Documentation releases require a semantic version tag like v1.2.3.");
    expect(workflow).toContain("FOCOWIKI_RELEASE_VERSION: ${{ steps.release.outputs.version }}");
    expect(workflow).toContain("pnpm docs:validate");
    expect(workflow).toContain("actions/upload-pages-artifact@v5.0.0");
    expect(workflow).toContain("actions/deploy-pages@v5.0.0");
    expect(cname).toBe("docs.focowiki.com");
  });

  it("runs release-sensitive validation in default CI", () => {
    const workflow = readFileSync(ciWorkflowPath, "utf8");

    expect(workflow).toContain("pnpm test:validation");
    expect(workflow).toContain("pnpm openapi:validate");
    expect(workflow).toContain("FOCOWIKI_RELEASE_VERSION: 0.0.0-ci");
    expect(workflow).toContain(
      "docker build --target api --build-arg FOCOWIKI_RELEASE_VERSION=0.0.0-ci -t focowiki-api:ci ."
    );
    expect(workflow).toContain("grep 'FOCOWIKI_RELEASE_VERSION=0.0.0-ci'");
    expect(workflow).toContain("docker build --target admin -t focowiki-admin:ci .");
  });

  it("keeps env template keys and Compose references synchronized", () => {
    const devEnvKeys = parseEnvKeys(readFileSync(devEnvTemplatePath, "utf8"));
    const deploymentEnvKeys = parseEnvKeys(readFileSync(deploymentEnvTemplatePath, "utf8"));
    const deploymentComposeRefs = parseComposeEnvRefs(readFileSync(deploymentComposeTemplatePath, "utf8"));
    const devComposeRefs = parseComposeEnvRefs(readFileSync(devComposeTemplatePath, "utf8"));
    const localComposeRefs = parseComposeEnvRefs(readFileSync(localComposeTemplatePath, "utf8"));
    const deploymentOnlyKeys = new Set(["FOCOWIKI_ADMIN_IMAGE", "FOCOWIKI_API_IMAGE"]);
    const comparableDeploymentKeys = new Set([...deploymentEnvKeys].filter((key) => !deploymentOnlyKeys.has(key)));

    expect([...devEnvKeys].sort()).toEqual([...comparableDeploymentKeys].sort());
    expect([...deploymentComposeRefs].filter((key) => !deploymentEnvKeys.has(key))).toEqual([]);
    expect([...devComposeRefs].filter((key) => !devEnvKeys.has(key))).toEqual([]);
    expect([...localComposeRefs].filter((key) => !devEnvKeys.has(key))).toEqual([]);
  });
});

function parseEnvKeys(contents: string): Set<string> {
  return new Set(
    contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && /^[A-Z][A-Z0-9_]*=/.test(line))
      .map((line) => line.slice(0, line.indexOf("=")))
      .filter((key): key is string => key.length > 0)
  );
}

function parseComposeEnvRefs(contents: string): Set<string> {
  return new Set(
    [...contents.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)]
      .map((match) => match[1])
      .filter((key): key is string => typeof key === "string")
  );
}
