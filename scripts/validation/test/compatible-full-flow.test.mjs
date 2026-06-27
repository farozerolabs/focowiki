import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  assertEnvTemplateFieldsAligned,
  compareEnvTemplateFields,
  parseEnvKeys
} from "../lib/compatible-full-flow/env-files.mjs";
import {
  assertLocalCleanRoomGuard,
  assertNonDestructiveValidationEnv
} from "../lib/compatible-full-flow/guards.mjs";
import {
  assertMigrationCompatibility,
  findMigrationCompatibilityFindings
} from "../lib/compatible-full-flow/migration-safety.mjs";
import {
  createCleanupPlan,
  createRunState,
  diagnoseOlderValidationMarkers,
  recordValidationCleanupResult,
  recordValidationResource
} from "../lib/compatible-full-flow/run-state.mjs";
import { readCompatibleFullFlowConfig } from "../lib/compatible-full-flow/config.mjs";

test("parseEnvKeys compares field names without exposing values", () => {
  assert.deepEqual(
    parseEnvKeys("A=secret\n# B=ignored\nC = value\nINVALID LINE\nA=duplicate\n"),
    ["A", "C"]
  );
});

test("compareEnvTemplateFields reports missing and extra keys only", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "focowiki-env-fields-"));

  try {
    fs.writeFileSync(path.join(root, ".env.example"), "A=one\nB=two\n");
    fs.writeFileSync(path.join(root, ".env"), "A=secret\nC=another-secret\n");
    const comparison = compareEnvTemplateFields({ cwd: root });

    assert.deepEqual(comparison.missingInEnv, ["B"]);
    assert.deepEqual(comparison.extraInEnv, ["C"]);
    assert.throws(
      () => assertEnvTemplateFieldsAligned(comparison),
      /Environment fields are not aligned/
    );
    assert.equal(JSON.stringify(comparison).includes("secret"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("migration compatibility allows derived summary rebuilds and blocks durable destructive SQL", () => {
  assert.deepEqual(
    findMigrationCompatibilityFindings(`
      DELETE FROM focowiki.worker_queue_summaries;
      INSERT INTO focowiki.worker_queue_summaries SELECT * FROM focowiki.worker_jobs;
    `),
    []
  );

  const findings = findMigrationCompatibilityFindings(`
    DROP TABLE IF EXISTS focowiki.upload_tasks;
    ALTER TABLE focowiki.source_files DROP COLUMN task_id;
    UPDATE focowiki.knowledge_bases SET active_release_id = NULL;
    DELETE FROM focowiki.releases;
  `);

  assert.deepEqual(
    findings.map((finding) => finding.code),
    ["DROP_TABLE", "DROP_COLUMN", "BROAD_KNOWLEDGE_BASE_MUTATION", "BROAD_DURABLE_DELETE"]
  );
  assert.throws(
    () => assertMigrationCompatibility("TRUNCATE focowiki.source_files;"),
    /Migration compatibility check failed/
  );
});

test("non-destructive validation guard refuses destructive flags", () => {
  assert.doesNotThrow(() => assertNonDestructiveValidationEnv({}));
  assert.throws(
    () =>
      assertNonDestructiveValidationEnv({
        FOCOWIKI_VALIDATION_FLUSH_REDIS: "true"
      }),
    /refuses destructive flags/
  );
});

test("local clean-room guard requires compatible evidence and local configuration", () => {
  const compatibleEvidence = {
    kind: "compatible-full-flow",
    mode: "compatible",
    ok: true
  };
  const localConfig = {
    env: {
      FOCOWIKI_VALIDATION_ALLOW_LOCAL_RESET: "true",
      APP_ENV: "development",
      ADMIN_PUBLIC_ORIGIN: "http://127.0.0.1:43100",
      ADMIN_API_PUBLIC_ORIGIN: "http://localhost:43000",
      PUBLIC_BASE_URL: "http://127.0.0.1:43200",
      PUBLIC_OPENAPI_PUBLIC_ORIGIN: "http://localhost:43200",
      DATABASE_URL: "postgres://focowiki:focowiki@127.0.0.1:55432/focowiki",
      REDIS_URL: "redis://127.0.0.1:56379/0",
      S3_ENDPOINT: "http://127.0.0.1:9000",
      S3_PREFIX: "local-validation"
    }
  };

  assert.doesNotThrow(() => assertLocalCleanRoomGuard(localConfig, compatibleEvidence));
  assert.throws(
    () =>
      assertLocalCleanRoomGuard(
        {
          env: {
            ...localConfig.env,
            PUBLIC_BASE_URL: "https://openapi.example.com"
          }
        },
        compatibleEvidence
      ),
    /refuses remote origins/
  );
  assert.throws(
    () =>
      assertLocalCleanRoomGuard(
        {
          env: {
            ...localConfig.env,
            APP_ENV: "production"
          }
        },
        compatibleEvidence
      ),
    /refuses APP_ENV=production/
  );
  assert.throws(
    () =>
      assertLocalCleanRoomGuard(
        {
          env: {
            ...localConfig.env,
            S3_ENDPOINT: "https://test-storage.example.com"
          }
        },
        compatibleEvidence
      ),
    /refuses non-local S3_ENDPOINT/
  );
  assert.doesNotThrow(() =>
    assertLocalCleanRoomGuard(
      {
        env: {
          ...localConfig.env,
          FOCOWIKI_VALIDATION_ALLOW_REMOTE_TEST_S3_RESET: "true",
          S3_ENDPOINT: "https://test-storage.example.com"
        }
      },
      compatibleEvidence
    )
  );
  assert.throws(
    () =>
      assertLocalCleanRoomGuard(
        {
          env: {
            ...localConfig.env,
            FOCOWIKI_VALIDATION_ALLOW_REMOTE_TEST_S3_RESET: "true",
            S3_ENDPOINT: "https://test-storage.example.com",
            S3_PREFIX: "production"
          }
        },
        compatibleEvidence
      ),
    /refuses production-like S3_PREFIX/
  );
});

test("run-state records and plans only current-run resources", () => {
  const state = createRunState({ runId: "validation-20260101000000-12345678" });

  recordValidationResource(state, "knowledgeBases", {
    id: "kb-current",
    runId: state.runId
  });
  state.resources.knowledgeBases.push({
    id: "kb-old",
    runId: "validation-older"
  });

  const plan = createCleanupPlan(state);
  const older = diagnoseOlderValidationMarkers(state.resources.knowledgeBases, state.runId);

  assert.deepEqual(
    plan.resources.knowledgeBases.map((resource) => resource.id),
    ["kb-current"]
  );
  assert.deepEqual(older, [
    {
      type: "unknown",
      id: "kb-old",
      runId: "validation-older",
      action: "dry-run-only"
    }
  ]);
});

test("run-state cleanup result records current-run deletions without removing local evidence", () => {
  const state = createRunState({ runId: "validation-20260101000000-12345678" });

  recordValidationResource(state, "knowledgeBases", {
    id: "kb-current",
    runId: state.runId
  });
  recordValidationResource(state, "reports", {
    id: "validation-report.json",
    runId: state.runId
  });
  state.resources.sourceFiles.push({
    id: "source-old",
    runId: "validation-older"
  });

  recordValidationCleanupResult(state);

  assert.equal(state.cleanup.currentRunOnly, true);
  assert.equal(state.cleanup.deleted[0].id, "kb-current");
  assert.equal(state.cleanup.skipped[0].id, "validation-report.json");
  assert.equal(state.cleanup.unresolved[0].id, "source-old");
});

test("compatible config reads CLI sample directory and redacts report roots by convention", () => {
  const config = readCompatibleFullFlowConfig({
    command: "preflight",
    argv: ["--", "--markdown-dir", "fixtures", "--sample-count", "14"],
    env: {
      APP_ENV: "development"
    },
    cwd: "/repo"
  });

  assert.equal(config.markdownDir, "fixtures");
  assert.equal(config.sampleCount, 14);
  assert.equal(path.basename(config.reportDir), "validate-compatible-full-e2e");
});

test("cleanup dry-run config writes a separate report from compatible evidence", () => {
  const compatible = readCompatibleFullFlowConfig({
    command: "compatible",
    env: {
      APP_ENV: "development"
    },
    cwd: "/repo"
  });
  const cleanup = readCompatibleFullFlowConfig({
    command: "cleanup-dry-run",
    env: {
      APP_ENV: "development"
    },
    cwd: "/repo"
  });

  assert.equal(path.basename(compatible.reportPath), "compatible-full-flow-report.json");
  assert.equal(
    path.basename(cleanup.reportPath),
    "compatible-full-flow-cleanup-dry-run-report.json"
  );
});
