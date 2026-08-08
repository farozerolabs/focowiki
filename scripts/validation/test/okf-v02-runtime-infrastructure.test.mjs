import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createOkfV02RuntimeInfrastructure,
  createOkfV02RuntimeEnvironment,
  createOkfV02RuntimeProjectName,
  assertOkfV02RuntimeServicesRunning,
  readOkfV02RuntimeFailureSummary
} from "../lib/okf-v02-runtime-infrastructure.mjs";

test("runtime health checks fail fast when a required worker exits", () => {
  assert.throws(() => assertOkfV02RuntimeServicesRunning({
    isRunning: (serviceName) => serviceName !== "maintenance-worker",
    exitState: (serviceName) => serviceName === "maintenance-worker"
      ? { code: 1, signal: null }
      : null
  }), /maintenance-worker.*code=1/u);
});

test("runtime cleanup removes containers from both search profiles", async () => {
  const commands = [];
  const infrastructure = createOkfV02RuntimeInfrastructure({
    env: {},
    workspace: {
      runId: "cleanup-profiles",
      root: path.join(os.tmpdir(), "okf-v02-cleanup")
    },
    runCommand: async (command, args) => {
      commands.push({ command, args });
      if (command === process.execPath && args.includes("apps/api/src/db/migrate.ts")) {
        throw new Error("stop before application startup");
      }
      return "";
    },
    supervisorFactory: () => {
      throw new Error("supervisor must not start");
    }
  });

  await assert.rejects(infrastructure.start("meilisearch"), /stop before/u);
  await infrastructure.cleanup();

  const cleanup = commands.findLast((command) => command.args.includes("down"));
  assert.ok(cleanup);
  assert.deepEqual(
    cleanup.args.filter((value) => value === "meilisearch" || value === "opensearch"),
    ["meilisearch", "opensearch"]
  );
});

test("runtime environment isolates every owned store from external environment values", () => {
  const base = {
    POSTGRES_PORT: "45432",
    REDIS_PORT: "46379",
    S3_PORT: "49000",
    MEILI_PORT: "47700",
    OPENSEARCH_PORT: "49200",
    DATABASE_URL: "postgres://external.example/runtime",
    REDIS_URL: "rediss://external.example/0",
    S3_ENDPOINT: "https://external.example",
    S3_ACCESS_KEY_ID: "external-key",
    S3_SECRET_ACCESS_KEY: "external-secret"
  };
  const meili = createOkfV02RuntimeEnvironment(
    base,
    "meilisearch",
    "/tmp/run-1/meilisearch"
  );
  const openSearch = createOkfV02RuntimeEnvironment(
    base,
    "opensearch",
    "/tmp/run-1/opensearch"
  );

  assert.equal(meili.SEARCH_PROVIDER, "meilisearch");
  assert.equal(meili.COMPOSE_PROFILES, "meilisearch");
  assert.equal(meili.MEILI_HOST, "http://127.0.0.1:47700");
  assert.equal(openSearch.SEARCH_PROVIDER, "opensearch");
  assert.equal(openSearch.COMPOSE_PROFILES, "opensearch");
  assert.equal(openSearch.OPENSEARCH_URL, "http://127.0.0.1:49200");
  assert.equal(openSearch.OPENSEARCH_AUTH_MODE, "none");
  assert.equal(
    openSearch.DATABASE_URL,
    "postgres://focowiki_e2e:focowiki-e2e-postgres@127.0.0.1:45432/focowiki_e2e"
  );
  assert.equal(openSearch.REDIS_URL, "redis://127.0.0.1:46379/0");
  assert.equal(openSearch.S3_ENDPOINT, "http://127.0.0.1:49000");
  assert.equal(openSearch.S3_ACCESS_KEY_ID, "focowiki-e2e");
  assert.equal(openSearch.S3_SECRET_ACCESS_KEY, "focowiki-e2e-minio-secret");
  assert.equal(openSearch.S3_FORCE_PATH_STYLE, "true");
  assert.match(openSearch.S3_BUCKET, /^focowiki-e2e-[a-f0-9]{12}$/u);
  assert.equal(openSearch.S3_BUCKET, meili.S3_BUCKET);
  assert.equal(openSearch.S3_PREFIX, meili.S3_PREFIX);
  assert.equal(openSearch.SEARCH_INDEX_PREFIX, meili.SEARCH_INDEX_PREFIX);
});

test("runtime project names are stable, bounded, and Compose-safe", () => {
  const first = createOkfV02RuntimeProjectName("run-123");
  const second = createOkfV02RuntimeProjectName("run-123");
  const other = createOkfV02RuntimeProjectName("run-456");

  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.match(first, /^[a-z0-9]+$/u);
  assert.ok(first.length <= 40);
});

test("runtime failure summaries retain safe diagnostics and redact local paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-v02-runtime-log-"));
  try {
    const directory = path.join(root, "meilisearch");
    await fs.mkdir(directory, { recursive: true });
    const fakeHomePath = ["", "Users", "example", "private", "concept.md"].join("/");
    await fs.writeFile(path.join(directory, "focowiki-publication-worker.log"), [
      JSON.stringify({ level: "info", event: "ignored" }),
      JSON.stringify({
        level: "error",
        event: "publication_worker.item_failed",
        fields: {
          failureCode: "PUBLICATION_FAILED",
          errorClass: "Error",
          errorMessage: `Failed at ${fakeHomePath}`
        }
      })
    ].join("\n"));

    await assert.doesNotReject(async () => {
      assert.deepEqual(await readOkfV02RuntimeFailureSummary(root), [{
        provider: "meilisearch",
        service: "publication-worker",
        event: "publication_worker.item_failed",
        failureCode: "PUBLICATION_FAILED",
        errorClass: "Error",
        errorMessage: "Failed at <REDACTED_PATH>"
      }]);
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
