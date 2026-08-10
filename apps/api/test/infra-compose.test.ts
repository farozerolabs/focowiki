import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const rootDir = resolve(import.meta.dirname, "../../..");
const devComposeTemplatePath = resolve(rootDir, "docker-compose.dev.yml.example");
const localComposeTemplatePath = resolve(rootDir, "docker-compose.local.yml.example");
const deploymentComposeTemplatePath = resolve(rootDir, "docker-compose.yml.example");
const dockerfilePath = resolve(rootDir, "Dockerfile");
const adminNginxTemplatePath = resolve(
  rootDir,
  "deploy/nginx/default.conf.template"
);
const dockerignorePath = resolve(rootDir, ".dockerignore");
const gitignorePath = resolve(rootDir, ".gitignore");
const packageJsonPath = resolve(rootDir, "package.json");
const devEnvTemplatePath = resolve(rootDir, ".env.dev.example");
const deploymentEnvTemplatePath = resolve(rootDir, ".env.example");
const ciWorkflowPath = resolve(rootDir, ".github/workflows/ci.yml");
const dockerBuildWorkflowPath = resolve(rootDir, ".github/workflows/docker-build.yml");
const dockerPublishWorkflowPath = resolve(rootDir, ".github/workflows/docker-publish.yml");
const dockerPrereleaseWorkflowPath = resolve(rootDir, ".github/workflows/docker-prerelease.yml");
const docsPublishWorkflowPath = resolve(rootDir, ".github/workflows/docs-publish.yml");
const docsCnamePath = resolve(rootDir, "docs/public/CNAME");
const apiConfigSourcePath = resolve(rootDir, "apps/api/src/config.ts");
const apiMainSourcePath = resolve(rootDir, "apps/api/src/main.ts");
const deploymentHealthcheckSourcePath = resolve(
  rootDir,
  "apps/api/src/runtime/deployment-healthcheck.ts"
);
const searchInitMainSourcePath = resolve(
  rootDir,
  "apps/api/src/search-init-main.ts"
);
const workerMainSourcePaths = [
  "source-worker-main.ts",
  "publication-worker-main.ts",
  "maintenance-worker-main.ts"
].map((fileName) => resolve(rootDir, "apps/api/src", fileName));

describe("Docker Compose infrastructure", () => {
  it("re-resolves the Admin API proxy target after API container replacement", () => {
    const nginxTemplate = readFileSync(adminNginxTemplatePath, "utf8");

    expect(nginxTemplate).toContain("resolver 127.0.0.11 valid=10s ipv6=off;");
    expect(nginxTemplate).toContain(
      "set $admin_api_proxy_target ${ADMIN_API_PROXY_TARGET};"
    );
    expect(nginxTemplate).toContain("proxy_pass $admin_api_proxy_target;");
    expect(nginxTemplate).not.toContain(
      "proxy_pass ${ADMIN_API_PROXY_TARGET};"
    );
  });

  it("defines the complete locally built runtime topology in the local template", () => {
    const compose = readFileSync(localComposeTemplatePath, "utf8");

    for (const service of [
      "admin:",
      "api:",
      "source-worker:",
      "publication-worker:",
      "maintenance-worker:",
      "search-init:",
      "migrate:",
      "postgres:",
      "redis:",
      "minio:",
      "minio-init:",
      "meilisearch:",
      "opensearch:"
    ]) {
      expect(compose).toContain(service);
    }

    expect(compose).toContain("image: focowiki-api:dev");
    expect(compose).toContain("image: focowiki-admin:dev");
    expect(compose).toContain("apps/api/runtime/source-worker.mjs");
    expect(compose).toContain("apps/api/runtime/publication-worker.mjs");
    expect(compose).toContain("apps/api/runtime/maintenance-worker.mjs");
    expect(compose).toContain("DATABASE_URL: postgres://${POSTGRES_USER:");
    expect(compose).toContain("@postgres:5432/");
    expect(compose).toContain("REDIS_URL: redis://redis:6379/0");
    expect(compose).toContain("MEILI_HOST: http://meilisearch:7700");
    expect(compose).toContain("ADMIN_API_PROXY_TARGET: http://api:");
    expect(compose).toContain("${POSTGRES_PORT:?Set POSTGRES_PORT in .env}:5432");
    expect(compose).toContain("${REDIS_PORT:?Set REDIS_PORT in .env}:6379");
    expect(compose).toContain("./data/postgres:/var/lib/postgresql");
    expect(compose).toContain("./data/redis:/data");
    expect(compose).toContain("./data/meilisearch:/meili_data");
    expect(compose).toContain("./data/meilisearch/tmp:/meili_data/tmp");
    expect(compose).toContain("./data/meilisearch-snapshots:/meili_snapshots");
    expect(compose).toContain("./data/meilisearch-dumps:/meili_dumps");
    expect(compose).toContain("MEILI_SNAPSHOT_DIR: ${MEILI_SNAPSHOT_DIR-}");
    expect(compose).toContain(
      "MEILI_SCHEDULE_SNAPSHOT: ${MEILI_SCHEDULE_SNAPSHOT-}"
    );
    expect(compose).toContain("MEILI_DUMP_DIR: ${MEILI_DUMP_DIR-}");
    expect(compose).toContain("TMPDIR: /meili_data/tmp");
    expect(compose).not.toContain("7700:7700");
    expect(compose).not.toContain("MEILI_PORT");
    expect(compose).toContain("x-docker-logging: &docker-logging");
    expect(compose).toContain('max-size: "10m"');
    expect(compose).toContain('max-file: "3"');
    expect(compose.match(/logging: \*docker-logging/g)).toHaveLength(13);
    expect(compose).not.toMatch(/\$\{[A-Z][A-Z0-9_]*:-/);
  });

  it("applies the measured worker heap caps in every deployment template", () => {
    for (const composePath of [
      deploymentComposeTemplatePath,
      devComposeTemplatePath,
      localComposeTemplatePath
    ]) {
      const compose = readFileSync(composePath, "utf8");
      expect(composeServiceSection(compose, "source-worker")).toContain(
        'command: ["node", "--max-old-space-size=256", "apps/api/runtime/source-worker.mjs"]'
      );
      expect(composeServiceSection(compose, "publication-worker")).toContain(
        'command: ["node", "--max-old-space-size=512", "apps/api/runtime/publication-worker.mjs"]'
      );
    }
  });

  it("bounds Redis AOF growth in every deployment template", () => {
    for (const composePath of [
      deploymentComposeTemplatePath,
      devComposeTemplatePath,
      localComposeTemplatePath
    ]) {
      const compose = readFileSync(composePath, "utf8");
      const redis = composeServiceSection(compose, "redis");
      expect(redis).toContain('"--appendonly", "yes"');
      expect(redis).toContain('"--auto-aof-rewrite-percentage", "100"');
      expect(redis).toContain('"--auto-aof-rewrite-min-size", "8mb"');
    }
  });

  it("provides initialized S3-compatible storage in local development templates", () => {
    for (const composePath of [devComposeTemplatePath, localComposeTemplatePath]) {
      const compose = readFileSync(composePath, "utf8");
      const minio = composeServiceSection(compose, "minio");
      const minioInit = composeServiceSection(compose, "minio-init");
      const migrate = composeServiceSection(compose, "migrate");

      expect(compose).toContain("S3_ENDPOINT: http://minio:9000");
      expect(minio).toContain("image: minio/minio:RELEASE.2025-09-07T16-13-09Z");
      expect(minio).toContain("MINIO_ROOT_USER: ${S3_ACCESS_KEY_ID:");
      expect(minio).toContain("MINIO_ROOT_PASSWORD: ${S3_SECRET_ACCESS_KEY:");
      expect(minio).toContain("./data/minio:/data");
      expect(minioInit).toContain("image: minio/mc:RELEASE.2025-08-13T08-35-41Z");
      expect(minioInit).toContain("mc mb --ignore-existing");
      expect(minioInit).toContain("mc version enable");
      expect(migrate).toContain(
        "minio-init:\n        condition: service_completed_successfully"
      );
    }

    const localCompose = readFileSync(localComposeTemplatePath, "utf8");
    expect(localCompose).toContain(
      '"127.0.0.1:${S3_PORT:?Set S3_PORT in .env}:9000"'
    );
  });

  it("does not define embedded or in-process infrastructure fallbacks", () => {
    const compose = readFileSync(localComposeTemplatePath, "utf8");

    expect(compose).not.toMatch(/sqlite|embedded|in-memory|memory-backed/i);
  });

  it("defines the Docker development stack with local build targets", () => {
    const compose = readFileSync(devComposeTemplatePath, "utf8");

    for (const service of [
      "admin:",
      "api:",
      "source-worker:",
      "publication-worker:",
      "maintenance-worker:",
      "search-init:",
      "migrate:",
      "postgres:",
      "redis:",
      "minio:",
      "minio-init:",
      "meilisearch:",
      "opensearch:"
    ]) {
      expect(compose).toContain(service);
    }

    expect(compose).toContain("image: focowiki-api:dev");
    expect(compose).toContain("image: focowiki-admin:dev");
    expect(compose).toContain("target: api");
    expect(compose).toContain("target: admin");
    expect(compose).toContain("apps/api/runtime/migrate.mjs");
    expect(compose).toContain("apps/api/runtime/source-worker.mjs");
    expect(compose).toContain("apps/api/runtime/publication-worker.mjs");
    expect(compose).toContain("apps/api/runtime/maintenance-worker.mjs");
    expect(compose).toContain("--healthcheck");
    expect(compose).toContain("stop_grace_period: 30s");
    expect(compose).toContain("x-docker-logging: &docker-logging");
    expect(compose).toContain('max-size: "10m"');
    expect(compose).toContain('max-file: "3"');
    expect(compose).toContain("./logs:/app/logs");
    expect(compose).toContain("./runtime-secrets:/app/runtime-secrets");
    expect(compose).toContain("./data/postgres:/var/lib/postgresql");
    expect(compose).toContain("./data/redis:/data");
    expect(compose).toContain("./data/meilisearch:/meili_data");
    expect(compose).toContain("./data/meilisearch/tmp:/meili_data/tmp");
    expect(compose).toContain("./data/meilisearch-snapshots:/meili_snapshots");
    expect(compose).toContain("./data/meilisearch-dumps:/meili_dumps");
    expect(compose).toContain("MEILI_SNAPSHOT_DIR: ${MEILI_SNAPSHOT_DIR-}");
    expect(compose).toContain(
      "MEILI_SCHEDULE_SNAPSHOT: ${MEILI_SCHEDULE_SNAPSHOT-}"
    );
    expect(compose).toContain("MEILI_DUMP_DIR: ${MEILI_DUMP_DIR-}");
    expect(compose).toContain("TMPDIR: /meili_data/tmp");
    expect(compose).toContain("getmeili/meilisearch:v1.51.0");
    expect(compose).not.toContain("LOG_FILE_HOST_DIR");
    expect(compose).not.toMatch(/^volumes:\n[\s\S]*^\s{2}runtime-secrets:/m);
    expect(compose.match(/logging: \*docker-logging/g)).toHaveLength(13);
    expect(compose).not.toMatch(/ghcr\.io\/farozerolabs\/focowiki-/);
  });

  it("defines the deployment stack as a committed GHCR Compose template", () => {
    const compose = readFileSync(deploymentComposeTemplatePath, "utf8");

    for (const service of [
      "admin:",
      "api:",
      "source-worker:",
      "publication-worker:",
      "maintenance-worker:",
      "search-init:",
      "migrate:",
      "postgres:",
      "redis:",
      "meilisearch:",
      "opensearch:"
    ]) {
      expect(compose).toContain(service);
    }

    expect(compose).toContain("${FOCOWIKI_API_IMAGE:-ghcr.io/farozerolabs/focowiki-api:latest}");
    expect(compose).toContain("${FOCOWIKI_ADMIN_IMAGE:-ghcr.io/farozerolabs/focowiki-admin:latest}");
    expect(compose).not.toContain("target: api");
    expect(compose).not.toContain("target: admin");
    expect(compose).not.toContain("build:");
    expect(compose).toContain("apps/api/runtime/migrate.mjs");
    expect(compose).toContain("apps/api/runtime/source-worker.mjs");
    expect(compose).toContain("apps/api/runtime/publication-worker.mjs");
    expect(compose).toContain("apps/api/runtime/maintenance-worker.mjs");
    expect(compose).toContain("--healthcheck");
    expect(compose).toContain("stop_grace_period: 30s");
    expect(compose).toContain("127.0.0.1:${ADMIN_UI_PORT:?Set ADMIN_UI_PORT in .env}:8080");
    expect(compose).toContain("127.0.0.1:${ADMIN_API_PORT:?Set ADMIN_API_PORT in .env}:${ADMIN_API_PORT:?Set ADMIN_API_PORT in .env}");
    expect(compose).toContain(
      "127.0.0.1:${PUBLIC_OPENAPI_PORT:?Set PUBLIC_OPENAPI_PORT in .env}:${PUBLIC_OPENAPI_PORT:?Set PUBLIC_OPENAPI_PORT in .env}"
    );
    expect(compose).toContain("./data/postgres:/var/lib/postgresql");
    expect(compose).toContain("./data/redis:/data");
    expect(compose).toContain("./data/meilisearch:/meili_data");
    expect(compose).toContain("./data/meilisearch/tmp:/meili_data/tmp");
    expect(compose).toContain("./data/meilisearch-snapshots:/meili_snapshots");
    expect(compose).toContain("./data/meilisearch-dumps:/meili_dumps");
    expect(compose).toContain("MEILI_SNAPSHOT_DIR: ${MEILI_SNAPSHOT_DIR-}");
    expect(compose).toContain(
      "MEILI_SCHEDULE_SNAPSHOT: ${MEILI_SCHEDULE_SNAPSHOT-}"
    );
    expect(compose).toContain("MEILI_DUMP_DIR: ${MEILI_DUMP_DIR-}");
    expect(compose).toContain("TMPDIR: /meili_data/tmp");
    expect(compose).toContain("getmeili/meilisearch:v1.51.0");
    expect(compose).toContain("./logs:/app/logs");
    expect(compose).toContain("./runtime-secrets:/app/runtime-secrets");
    expect(compose).not.toContain("postgres-data:");
    expect(compose).not.toContain("redis-data:");
    expect(compose).not.toMatch(/^volumes:\n[\s\S]*^\s{2}runtime-secrets:/m);
    expect(compose).toContain("depends_on:");
    expect(compose).toContain("condition: service_healthy");
    expect(compose).toContain("env_file:");
    expect(compose).toContain("- .env");
    expect(compose).toContain("x-docker-logging: &docker-logging");
    expect(compose).toContain('max-size: "10m"');
    expect(compose).toContain('max-file: "3"');
    expect(compose).not.toContain("LOG_FILE_HOST_DIR");
    expect(compose.match(/logging: \*docker-logging/g)).toHaveLength(11);
    expect(compose).not.toContain("x-api-environment");
    expect(compose).not.toContain("S3_ENDPOINT:");
    expect(compose).not.toMatch(/(^|\n)\s+s3:|(^|\n)\s+s3-init:|minio|minio\/mc|s3-data:/i);
    expect(compose).not.toMatch(/sqlite|embedded|in-memory|memory-backed/i);
  });

  it("uses standard infrastructure with loopback-only host exposure", () => {
    const deploymentCompose = readFileSync(deploymentComposeTemplatePath, "utf8");
    const devCompose = readFileSync(devComposeTemplatePath, "utf8");
    const localCompose = readFileSync(localComposeTemplatePath, "utf8");

    for (const compose of [deploymentCompose, devCompose, localCompose]) {
      expect(compose).toContain("image: postgres:18-alpine");
      expect(compose).not.toMatch(/focowiki-postgres|docker\/postgres\/Dockerfile/u);
      expect(compose).not.toContain("7700:7700");
    }

    for (const compose of [deploymentCompose, devCompose, localCompose]) {
      expect(compose).toContain(
        '"127.0.0.1:${ADMIN_UI_PORT:?Set ADMIN_UI_PORT in .env}:8080"'
      );
      expect(compose).toContain(
        '"127.0.0.1:${ADMIN_API_PORT:?Set ADMIN_API_PORT in .env}:${ADMIN_API_PORT:?Set ADMIN_API_PORT in .env}"'
      );
      expect(compose).toContain(
        '"127.0.0.1:${PUBLIC_OPENAPI_PORT:?Set PUBLIC_OPENAPI_PORT in .env}:${PUBLIC_OPENAPI_PORT:?Set PUBLIC_OPENAPI_PORT in .env}"'
      );
    }
    expect(localCompose).toContain(
      '"127.0.0.1:${POSTGRES_PORT:?Set POSTGRES_PORT in .env}:5432"'
    );
    expect(localCompose).toContain(
      '"127.0.0.1:${REDIS_PORT:?Set REDIS_PORT in .env}:6379"'
    );
    expect(localCompose).toContain(
      '"127.0.0.1:${S3_PORT:?Set S3_PORT in .env}:9000"'
    );

    for (const service of ["postgres", "redis", "meilisearch"]) {
      const section = deploymentCompose.match(
        new RegExp(`\\n  ${service}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z0-9-]*:|$)`, "u")
      )?.[1] ?? "";
      expect(section, service).not.toContain("ports:");
    }
  });

  it("keeps Compose health checks on health-state-only probes", () => {
    const deploymentCompose = readFileSync(deploymentComposeTemplatePath, "utf8");
    const devCompose = readFileSync(devComposeTemplatePath, "utf8");

    for (const compose of [deploymentCompose, devCompose]) {
      expect(compose).toContain("http://127.0.0.1:8080/healthz");
      expect(compose).toContain("apps/api/runtime/main.mjs\", \"--healthcheck");
      expect(compose).toContain("apps/api/runtime/source-worker.mjs\", \"--healthcheck");
      expect(compose).toContain("apps/api/runtime/publication-worker.mjs\", \"--healthcheck");
      expect(compose).toContain("apps/api/runtime/maintenance-worker.mjs\", \"--healthcheck");
      expect(compose).not.toContain("/admin/api/session");
      expect(compose).not.toContain("/openapi/v1/version");
      expect(compose).not.toContain("/openapi/v1/openapi.json");
      expect(compose).not.toContain("apiVersion");
      expect(compose).not.toContain("authenticated");
    }

    for (const sourcePath of [apiMainSourcePath, ...workerMainSourcePaths]) {
      const source = readFileSync(sourcePath, "utf8");
      expect(source, sourcePath).toContain("runRuntimeDeploymentHealthcheck");
      expect(source, sourcePath).not.toMatch(
        /role_jobs|knowledge_base_projection_repairs|projection_repair_subtasks|knowledge_base_lexical_rebuilds|lexical_rebuild_work_items|storage_reconciliation_cycles/u
      );
    }

    const deploymentHealthcheck = readFileSync(
      deploymentHealthcheckSourcePath,
      "utf8"
    );
    expect(deploymentHealthcheck).toContain("/healthz");
    expect(deploymentHealthcheck).toContain('body?.status !== "ok"');
  });

  it("orders provider health, runtime secrets, migration, and runtime roles", () => {
    const searchInitMain = readFileSync(searchInitMainSourcePath, "utf8");
    expect(searchInitMain).toContain("bootstrapMeilisearchKeys");
    expect(searchInitMain).toContain("ensureBundledOpenSearchSecurityAssets");

    for (const composePath of [
      deploymentComposeTemplatePath,
      devComposeTemplatePath,
      localComposeTemplatePath
    ]) {
      const compose = readFileSync(composePath, "utf8");
      const searchInit = composeServiceSection(compose, "search-init");
      const migrate = composeServiceSection(compose, "migrate");

      expect(searchInit).toContain("apps/api/runtime/search-init.mjs");
      expect(searchInit).toContain("meilisearch:\n        condition: service_healthy");
      expect(migrate).toContain(
        "search-init:\n        condition: service_completed_successfully"
      );
      expect(migrate).toContain("postgres:\n        condition: service_healthy");
      expect(migrate).toContain("redis:\n        condition: service_healthy");

      for (const role of [
        "api",
        "source-worker",
        "publication-worker",
        "maintenance-worker"
      ]) {
        expect(composeServiceSection(compose, role), role).toContain(
          "migrate:\n        condition: service_completed_successfully"
        );
      }
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
    expect(dockerfile).toContain("apk add --no-cache libstdc++ openssl su-exec");
    expect(dockerfile).toContain("deploy/docker/api-entrypoint.sh");
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/local/bin/focowiki-api-entrypoint"]');
    expect(dockerfile).toContain("apps/api/runtime/main.mjs");
    expect(dockerfile).toContain("apps/api/runtime/search-init.mjs");
    expect(dockerfile).toContain("apps/api/runtime/source-worker.mjs");
    expect(dockerfile).toContain("apps/api/runtime/publication-worker.mjs");
    expect(dockerfile).toContain("apps/api/runtime/maintenance-worker.mjs");
    expect(dockerfile).toContain("apps/api/runtime/migration-preflight.mjs");
    expect(dockerfile).toContain("apps/api/runtime/migrations");
    expect(dockerfile).not.toMatch(/pnpm\s+--filter\s+@focowiki\/admin\s+dev|vite\s+--host|pnpm\s+dev/);
  });

  it("validates worker runtime artifacts in CI", () => {
    const workflow = readFileSync(ciWorkflowPath, "utf8");

    expect(workflow).toContain("Validate API Docker worker runtime");
    expect(workflow).toContain("apps/api/runtime/source-worker.mjs");
    expect(workflow).toContain("apps/api/runtime/publication-worker.mjs");
    expect(workflow).toContain("apps/api/runtime/maintenance-worker.mjs");
    expect(workflow).toContain("apps/api/runtime/migrate.mjs");
    expect(workflow).toContain("apps/api/runtime/migration-preflight.mjs");
    expect(workflow).toContain("apps/api/runtime/main.mjs");
    expect(workflow).toContain("apps/api/runtime/search-init.mjs");
    expect(workflow).toContain("Validate native tokenizer runtime");
    expect(workflow).toContain("runtime/node_modules/nodejieba");
    expect(workflow).toContain("grep -q nodejieba apps/api/runtime/publication-worker.mjs");
    expect(workflow).not.toContain("! grep -q nodejieba apps/api/runtime/publication-worker.mjs");
    expect(workflow).toContain("Validate storage vNext schema contracts");
    expect(workflow).toContain("Validate current schema idempotence");
  });

  it("proves migrations, role health, and source-to-activation flow in CI", () => {
    const workflow = readFileSync(ciWorkflowPath, "utf8");

    expect(workflow).toContain("services:");
    expect(workflow).toContain("postgres:18-alpine");
    expect(workflow).toContain("redis:8-alpine");
    expect(workflow).toContain("getmeili/meilisearch:v1.51.0");
    expect(workflow).toContain("opensearchproject/opensearch:3.8.0");
    expect(workflow).toContain("opensearchproject/opensearch:2.19.6");
    expect(workflow).toContain("FOCOWIKI_TEST_DATABASE_URL");
    expect(workflow).toContain("FOCOWIKI_TEST_MEILISEARCH_URL");
    expect(workflow).toContain("FOCOWIKI_TEST_MEILISEARCH_API_KEY");
    expect(workflow).toContain("FOCOWIKI_TEST_OPENSEARCH_URL");
    expect(workflow).toContain("FOCOWIKI_TEST_OPENSEARCH_VERSION");
    expect(workflow).toContain("FOCOWIKI_TEST_OPENSEARCH_RUN_OWNER");
    expect(workflow).toContain("59200:9200");
    expect(workflow).toContain("59219:9200");
    expect(workflow).toContain("Start maintained OpenSearch 2.19 compatibility fixture");
    expect(workflow).toContain("Validate maintained OpenSearch 2.19 compatibility");
    expect(workflow).toContain("Stop maintained OpenSearch 2.19 compatibility fixture");
    expect(workflow).toContain("docker rm --force focowiki-opensearch-2-19-ci");
    expect(workflow).toContain("docker image rm opensearchproject/opensearch:2.19.6");
    expect(workflow).toContain("Migrate CI database with API image");
    expect(workflow).toContain("Start S3 health fixture");
    expect(workflow).toContain("Validate API image role health");
    expect(workflow).toContain("source-worker.mjs --healthcheck");
    expect(workflow).toContain("publication-worker.mjs --healthcheck");
    expect(workflow).toContain("maintenance-worker.mjs --healthcheck");
    expect(workflow).toContain("focowiki-ci-runtime-secrets-");
    expect(workflow).toContain("/app/runtime-secrets/deployment.key");
    expect(workflow).toContain("docker volume rm");
    expect(workflow).toContain("Validate source-to-activation smoke flow");
  });

  it("proves the published API image supports every runtime role", () => {
    const workflow = readFileSync(dockerBuildWorkflowPath, "utf8");

    expect(workflow).toContain("getmeili/meilisearch:v1.51.0");
    expect(workflow).toContain("opensearchproject/opensearch:3.8.0");
    expect(workflow).toContain("FOCOWIKI_TEST_MEILISEARCH_URL");
    expect(workflow).toContain("FOCOWIKI_TEST_MEILISEARCH_API_KEY");
    expect(workflow).toContain("FOCOWIKI_TEST_OPENSEARCH_URL");
    expect(workflow).toContain("FOCOWIKI_TEST_OPENSEARCH_VERSION");
    expect(workflow).toContain("FOCOWIKI_TEST_OPENSEARCH_RUN_OWNER");
    expect(workflow).toContain("59200:9200");
    expect(workflow).toContain("Validate published API image roles");
    expect(workflow).toContain("Start S3 health fixture");
    expect(workflow).toContain("apps/api/runtime/migrate.mjs");
    expect(workflow).toContain("apps/api/runtime/migration-preflight.mjs");
    expect(workflow).toContain("apps/api/runtime/source-worker.mjs --healthcheck");
    expect(workflow).toContain("apps/api/runtime/publication-worker.mjs --healthcheck");
    expect(workflow).toContain("apps/api/runtime/maintenance-worker.mjs --healthcheck");
    expect(workflow).toContain("focowiki-build-runtime-secrets-");
    expect(workflow).toContain("/app/runtime-secrets/deployment.key");
    expect(workflow).toContain("docker volume rm");
    expect(workflow).toContain("Validate release native tokenizer runtime");
    expect(workflow).toContain("runtime/node_modules/nodejieba");
    expect(workflow).toContain("grep -q nodejieba apps/api/runtime/publication-worker.mjs");
    expect(workflow).not.toContain("! grep -q nodejieba apps/api/runtime/publication-worker.mjs");
    expect(workflow).toContain("docker/setup-qemu-action@v4.2.0");
    expect(workflow).toContain("platforms: linux/amd64,linux/arm64");
    expect(workflow).toContain("for platform in linux/amd64 linux/arm64");
    expect(workflow).toContain("Validate published Admin image architectures");
    expect(workflow).toContain("subject-digest: ${{ steps.build-api.outputs.digest }}");
    expect(workflow).toContain("provenance: mode=max");
    expect(workflow).toContain("sbom: true");
    expect(
      workflow.split('docker image rm --force "${image}" >/dev/null 2>&1 || true').length - 1
    ).toBe(4);
    expect(workflow).toContain(
      'docker image rm --force "${source_worker_image}" >/dev/null 2>&1 || true'
    );
    expect(workflow).not.toContain("focowiki-lexical-rebuild-worker");
    expect(workflow).not.toContain("LEXICAL_IMAGE");
    expect(workflow).toContain("http://127.0.0.1:43000/healthz");
    expect(workflow).toContain("http://127.0.0.1:43200/healthz");
  });

  it("keeps provider bootstrap credentials out of application runtimes", () => {
    for (const composePath of [
      deploymentComposeTemplatePath,
      devComposeTemplatePath,
      localComposeTemplatePath
    ]) {
      const compose = readFileSync(composePath, "utf8");

      expect(compose).toContain("x-runtime-environment: &runtime-environment");
      const runtimeEnvironment = compose.split("services:")[0] ?? "";
      expect(runtimeEnvironment).not.toContain("MEILI_MASTER_KEY");
      expect(runtimeEnvironment).not.toContain("OPENSEARCH_BOOTSTRAP_USERNAME");
      expect(runtimeEnvironment).not.toContain("OPENSEARCH_BOOTSTRAP_PASSWORD");
      expect(compose).toContain(
        'command: ["node", "apps/api/runtime/search-init.mjs"]'
      );
      expect(compose).toContain(
        "condition: service_completed_successfully"
      );
      expect(compose).toContain('MEILI_EXPERIMENTAL_ENABLE_METRICS: "true"');
      expect(compose).toContain("environment: *runtime-environment");
    }

    expect(readFileSync(deploymentComposeTemplatePath, "utf8")).toContain(
      "MEILI_MASTER_KEY: ${MEILI_MASTER_KEY-}"
    );
    for (const composePath of [devComposeTemplatePath, localComposeTemplatePath]) {
      expect(readFileSync(composePath, "utf8")).toContain(
        "MEILI_MASTER_KEY: ${MEILI_MASTER_KEY-}"
      );
    }
  });

  it("allows external search providers without starting bundled containers", () => {
    const deploymentCompose = readFileSync(deploymentComposeTemplatePath, "utf8");
    const deploymentEnv = readFileSync(deploymentEnvTemplatePath, "utf8");

    expect(deploymentCompose).toContain('profiles: ["opensearch"]');
    expect(deploymentCompose).toContain('profiles: ["meilisearch"]');
    expect(deploymentCompose).toContain("required: false");
    expect(deploymentEnv).toContain("COMPOSE_PROFILES=opensearch");
    expect(deploymentEnv).toContain("OPENSEARCH_URL=https://opensearch:9200");
    expect(deploymentEnv).toContain("MEILI_HOST=http://meilisearch:7700");
    expect(deploymentEnv).toContain("MEILI_API_KEY=");
    expect(deploymentEnv).toContain("MEILI_METRICS_API_KEY=");
  });

  it("keeps startup config from requiring Admin UI managed upload-generation env fields", () => {
    const configSource = readFileSync(apiConfigSourcePath, "utf8");

    for (const field of [
      "MAX_UPLOAD_BYTES",
      "GENERATION_BATCH_SIZE",
      "UPLOAD_FILE_PROCESSING_CONCURRENCY"
    ]) {
      expect(configSource).not.toContain(`requirePositiveInteger(env, "${field}"`);
    }
  });

  it("keeps the API runtime image free from copied workspace node_modules", () => {
    const dockerfile = readFileSync(dockerfilePath, "utf8");
    const apiRuntime = dockerfile.split("FROM node:24-alpine AS api")[1]?.split("FROM nginx:1.29-alpine AS admin")[0] ?? "";

    expect(apiRuntime).not.toContain("COPY --from=build /app/node_modules");
    expect(apiRuntime).not.toContain("COPY --from=build /app/apps/api/node_modules");
    expect(apiRuntime).not.toContain("production-dependencies");
    expect(apiRuntime).toContain("/usr/local/lib/node_modules/npm");
    expect(apiRuntime).toContain("/opt/yarn-v1.22.22");
    expect(apiRuntime).toContain("test ! -e /usr/local/bin/npm");
    expect(apiRuntime).toContain("apps/api/runtime/node_modules/nodejieba");
    expect(apiRuntime).toContain("apps/api/runtime");
    expect(apiRuntime).toContain("focowiki-api-entrypoint");

    const adminRuntime = dockerfile.split("FROM nginx:1.29-alpine AS admin")[1] ?? "";
    expect(adminRuntime).toContain("RUN apk upgrade --no-cache");
  });

  it("initializes mounted API log directories before dropping privileges", () => {
    const entrypointPath = resolve(rootDir, "deploy/docker/api-entrypoint.sh");
    const entrypoint = readFileSync(entrypointPath, "utf8");

    expect(entrypoint).toContain("LOG_FILE_DIR");
    expect(entrypoint).toContain("/app/runtime-secrets");
    expect(entrypoint).not.toContain("RUNTIME_SECRET_DIR");
    expect(entrypoint).toContain("mkdir -p");
    expect(entrypoint).toContain("chown -R node:node");
    expect(entrypoint).toContain("chmod 700");
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
      "runtime-secrets",
      "data",
      "backups",
      "logs",
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
    expect(devEnv).toContain("LOG_FILE_MAX_TOTAL_BYTES=67108864");
    expect(devEnv).toContain("LOG_FILE_RETENTION_DAYS=7");
    expect(devEnv).toContain("ADMIN_UI_HOST=0.0.0.0");
    expect(devEnv).not.toContain("LOG_FILE_HOST_DIR");
    expect(devEnv).not.toContain("RUNTIME_SECRET_DIR");
    expect(devEnv).not.toContain("RUNTIME_SECRET_HOST_DIR");
    expect(devEnv).not.toContain("DOCKER_LOG_MAX_SIZE");
    expect(devEnv).not.toContain("DOCKER_LOG_MAX_FILE");
    expect(devEnv).not.toContain("ADMIN_SESSION_SECRET=");
    expect(devEnv).not.toContain("SETTINGS_ENCRYPTION_SECRET=");
    expect(devEnv).not.toContain("ADMIN_SESSION_SECRET_MIN_LENGTH");
    expect(devEnv).toContain("DATABASE_URL=postgres://focowiki:focowiki@127.0.0.1:55432/focowiki");

    const localS3AccessKey = devEnv.match(/^S3_ACCESS_KEY_ID=(.+)$/mu)?.[1] ?? "";
    const localS3SecretKey = devEnv.match(/^S3_SECRET_ACCESS_KEY=(.+)$/mu)?.[1] ?? "";
    expect(localS3AccessKey.length).toBeGreaterThanOrEqual(3);
    expect(localS3SecretKey.length).toBeGreaterThanOrEqual(8);
    expect(deploymentEnv).toContain("APP_ENV=production");
    expect(deploymentEnv).toContain("LOG_LEVEL=info");
    expect(deploymentEnv).toContain("LOG_FILE_DIR=logs");
    expect(deploymentEnv).toContain("LOG_FILE_MAX_BYTES=10485760");
    expect(deploymentEnv).toContain("LOG_FILE_MAX_FILES=5");
    expect(deploymentEnv).toContain("LOG_FILE_MAX_TOTAL_BYTES=67108864");
    expect(deploymentEnv).toContain("LOG_FILE_RETENTION_DAYS=7");
    for (const localOrUnusedKey of [
      "ADMIN_UI_HOST",
      "VITE_ADMIN_API_BASE_URL",
      "POSTGRES_PORT",
      "REDIS_PORT",
      "CORS_ORIGINS"
    ]) {
      expect(deploymentEnv).not.toMatch(new RegExp(`^${localOrUnusedKey}=`, "mu"));
    }
    expect(deploymentEnv).not.toContain("LOG_FILE_HOST_DIR");
    expect(deploymentEnv).not.toContain("RUNTIME_SECRET_DIR");
    expect(deploymentEnv).not.toContain("RUNTIME_SECRET_HOST_DIR");
    expect(deploymentEnv).not.toContain("DOCKER_LOG_MAX_SIZE");
    expect(deploymentEnv).not.toContain("DOCKER_LOG_MAX_FILE");
    expect(deploymentEnv).not.toContain("ADMIN_SESSION_SECRET=");
    expect(deploymentEnv).not.toContain("SETTINGS_ENCRYPTION_SECRET=");
    expect(deploymentEnv).not.toContain("ADMIN_SESSION_SECRET_MIN_LENGTH");
    expect(deploymentEnv).toContain("DATABASE_URL=postgres://");
    expect(deploymentEnv).toContain("REDIS_URL=redis://redis:6379/0");
    expect(deploymentEnv).toContain("MEILI_HOST=http://meilisearch:7700");
    expect(deploymentEnv).toContain("MEILI_MASTER_KEY=");
    expect(deploymentEnv).toContain("MEILI_API_KEY=");
    expect(deploymentEnv).toContain("MEILI_METRICS_API_KEY=");
    expect(deploymentEnv).toContain(
      "MEILI_API_KEY_FILE=/app/runtime-secrets/meilisearch-api-key"
    );
    expect(deploymentEnv).toContain(
      "MEILI_METRICS_API_KEY_FILE=/app/runtime-secrets/meilisearch-metrics-key"
    );
    expect(deploymentEnv).toContain("MEILI_MAX_INDEXING_MEMORY=2GiB");
    expect(deploymentEnv).toContain("MEILI_MAX_INDEXING_THREADS=2");
    expect(deploymentEnv).toContain("MEILI_SNAPSHOT_DIR=/meili_snapshots");
    expect(deploymentEnv).toContain("MEILI_SCHEDULE_SNAPSHOT=86400");
    expect(deploymentEnv).toContain("MEILI_DUMP_DIR=/meili_dumps");
    expect(deploymentEnv).toContain("S3_ENDPOINT=https://s3.example.com");
    expect(deploymentEnv).toContain("S3_REGION=<set-storage-region>");
    expect(deploymentEnv).toContain("S3_BUCKET=<set-storage-bucket>");
    expect(deploymentEnv).toContain("S3_ACCESS_KEY_ID=<set-storage-access-key-id>");
    expect(deploymentEnv).toContain("S3_FORCE_PATH_STYLE=<true-or-false>");
    expect(deploymentEnv).not.toContain("S3_REGION=local");
    expect(deploymentEnv).not.toContain("S3_ACCESS_KEY_ID=focowiki");
    expect(deploymentEnv).toContain("FOCOWIKI_API_IMAGE=ghcr.io/farozerolabs/focowiki-api:latest");
    expect(deploymentEnv).toContain("FOCOWIKI_ADMIN_IMAGE=ghcr.io/farozerolabs/focowiki-admin:latest");
    for (const key of [
      "SOURCE_WORKER_DATABASE_POOL_MAX",
      "PUBLICATION_WORKER_DATABASE_POOL_MAX",
      "MAINTENANCE_WORKER_DATABASE_POOL_MAX"
    ]) {
      expect(devEnv).toContain(`${key}=`);
      expect(deploymentEnv).toContain(`${key}=`);
    }
    expect(devEnv).not.toMatch(/^WORKER_DATABASE_POOL_MAX=/m);
    expect(deploymentEnv).not.toMatch(/^WORKER_DATABASE_POOL_MAX=/m);
    expect(deploymentEnv).not.toContain("ADMIN_PASSWORD=change-me");
    expect(devEnv).not.toContain("PUBLIC_API_KEY");
    expect(devEnv).not.toContain("PUBLIC_API_AUTH_REQUIRED");
    expect(deploymentEnv).not.toContain("PUBLIC_API_KEY");
    expect(deploymentEnv).not.toContain("PUBLIC_API_AUTH_REQUIRED");
  });

  it("publishes stable Docker images from version tags without v-prefixed image tags", () => {
    const triggerWorkflow = readFileSync(dockerPublishWorkflowPath, "utf8");
    const buildWorkflow = readFileSync(dockerBuildWorkflowPath, "utf8");

    expect(triggerWorkflow).toContain('tags:\n      - "v*"');
    expect(triggerWorkflow).not.toContain("workflow_dispatch:");
    expect(triggerWorkflow).toContain("group: docker-stable-${{ github.ref }}");
    expect(triggerWorkflow).toContain("uses: ./.github/workflows/docker-build.yml");
    expect(triggerWorkflow).toContain("channel: stable");
    expect(triggerWorkflow).toContain("version: ${{ github.ref_name }}");
    expect(buildWorkflow).toContain("name: Resolve release version");
    expect(buildWorkflow).toContain("^v[0-9]+\\.[0-9]+\\.[0-9]+$");
    expect(buildWorkflow).toContain("Docker image releases require a semantic version tag like v1.2.3.");
    expect(buildWorkflow).toContain("name: Validate release contracts");
    expect(buildWorkflow).toContain("FOCOWIKI_RELEASE_VERSION: ${{ steps.release.outputs.version }}");
    expect(buildWorkflow).toContain("pnpm test:validation");
    expect(buildWorkflow).toContain("pnpm openapi:validate");
    expect(buildWorkflow).toContain("org.opencontainers.image.version=${{ steps.release.outputs.version }}");
    expect(buildWorkflow).toContain("name: Verify release source");
    expect(buildWorkflow).toContain("Stable Docker publishing is allowed only for commits already contained in main.");
    expect(buildWorkflow).not.toContain("type=ref,event=tag");
    expect(buildWorkflow).toContain("type=raw,value=${{ steps.release.outputs.version }}");
    expect(buildWorkflow).toContain("type=raw,value=${{ steps.release.outputs.major_minor }}");
    expect(buildWorkflow).toContain("type=raw,value=${{ steps.release.outputs.major }}");
    expect(buildWorkflow).toContain("type=sha,prefix=${{ steps.release.outputs.sha_prefix }}");
    expect(buildWorkflow).toContain(
      "type=raw,value=latest,enable=${{ steps.release.outputs.is_release_tag == 'true' }}"
    );
    expect(buildWorkflow).toContain("actions/attest-build-provenance@v4.1.0");
    expect(buildWorkflow).toContain("push-to-registry: true");
  });

  it("publishes manually versioned prerelease Docker images only from dev", () => {
    const triggerWorkflow = readFileSync(dockerPrereleaseWorkflowPath, "utf8");
    const buildWorkflow = readFileSync(dockerBuildWorkflowPath, "utf8");

    expect(triggerWorkflow).toContain("workflow_dispatch:");
    expect(triggerWorkflow).toContain('description: "Prerelease version, for example 0.6.18-rc.1."');
    expect(triggerWorkflow).toContain("group: docker-prerelease-${{ inputs.version }}");
    expect(triggerWorkflow).toContain("uses: ./.github/workflows/docker-build.yml");
    expect(triggerWorkflow).toContain("channel: prerelease");
    expect(triggerWorkflow).toContain("version: ${{ inputs.version }}");
    expect(buildWorkflow).toContain("Prerelease Docker publishing must run from the dev branch.");
    expect(buildWorkflow).toContain("^[0-9]+\\.[0-9]+\\.[0-9]+-rc\\.[1-9][0-9]*$");
    expect(buildWorkflow).toContain("Prerelease versions must use the format 1.2.3-rc.1.");
    expect(buildWorkflow).toContain("Prerelease Docker publishing must use the latest commit from dev.");
    expect(buildWorkflow).toContain('echo "is_release_tag=false"');
    expect(buildWorkflow).toContain('echo "sha_prefix=prerelease-sha-"');
  });

  it("publishes documentation from version tags with release version and custom domain", () => {
    const workflow = readFileSync(docsPublishWorkflowPath, "utf8");
    const cname = readFileSync(docsCnamePath, "utf8").trim();

    expect(workflow).toContain('tags:\n      - "v*"');
    expect(workflow).not.toContain("workflow_dispatch:");
    expect(workflow).not.toContain("branches:\n      - main");
    expect(workflow).toContain("group: pages");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("Documentation deployment requires a release tag.");
    expect(workflow).toContain("Documentation releases require a semantic version tag like v1.2.3.");
    expect(workflow).toContain("name: Verify main documentation source");
    expect(workflow).toContain("Documentation release tags must point to commits already contained in main.");
    expect(workflow).toContain("Documentation source refs must be contained in main.");
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
    const deploymentOnlyKeys = new Set([
      "FOCOWIKI_ADMIN_IMAGE",
      "FOCOWIKI_API_IMAGE",
      "OPENSEARCH_ADMIN_PASSWORD"
    ]);
    const developmentOnlyKeys = new Set([
      "ADMIN_UI_HOST",
      "OPENSEARCH_PORT",
      "POSTGRES_PORT",
      "REDIS_PORT",
      "S3_PORT",
      "VITE_ADMIN_API_BASE_URL"
    ]);
    const optionalComposeKeys = new Set([
      "MEILI_API_KEY",
      "MEILI_METRICS_API_KEY"
    ]);
    const comparableDeploymentKeys = new Set([...deploymentEnvKeys].filter((key) => !deploymentOnlyKeys.has(key)));
    const comparableDevKeys = new Set(
      [...devEnvKeys].filter((key) => !developmentOnlyKeys.has(key))
    );

    expect([...comparableDevKeys].sort()).toEqual([...comparableDeploymentKeys].sort());
    expect(
      [...deploymentComposeRefs].filter(
        (key) => !deploymentEnvKeys.has(key) && !optionalComposeKeys.has(key)
      )
    ).toEqual([]);
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
    [...contents.matchAll(/(?<!\$)\$\{([A-Z][A-Z0-9_]*)/g)]
      .map((match) => match[1])
      .filter((key): key is string => typeof key === "string")
  );
}

function composeServiceSection(contents: string, service: string): string {
  return contents.match(
    new RegExp(`\\n  ${service}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z0-9-]*:|$)`, "u")
  )?.[1] ?? "";
}
