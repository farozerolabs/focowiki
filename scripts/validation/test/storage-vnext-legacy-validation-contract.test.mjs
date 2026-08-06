import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const validationRoot = path.resolve("scripts/validation");
const apiScriptRoot = path.resolve("apps/api/scripts");
const workflowRoot = path.resolve(".github/workflows");
const removedStorageTables = [
  "active_object_refs",
  "active_projection_records",
  "admin_audit_events",
  "cleanup_object_deletions",
  "deletion_intents",
  "generation_object_refs",
  "generation_projection_records",
  "immutable_objects",
  "knowledge_base_lexical_rebuilds",
  "knowledge_base_projection_repairs",
  "knowledge_base_projection_versions",
  "lexical_rebuild_work_items",
  "model_invocations",
  "projection_compaction_jobs",
  "projection_repair_subtasks",
  "publication_generations",
  "publication_impacts",
  "publication_progress",
  "publication_projection_inputs",
  "publication_subtasks",
  "resource_operation_targets",
  "resource_operations",
  "role_heartbeats",
  "role_jobs",
  "runtime_settings",
  "source_dispatch_markers",
  "source_file_events",
  "storage_reconciliation_cycles",
  "upload_session_entries"
];
const obsoleteRuntimeSymbols = [
  "createPublicationModeOverride"
];

test("runtime validation uses only storage vNext persistence evidence", () => {
  const failures = [];

  for (const filePath of collectRuntimeValidationFiles(validationRoot)) {
    const source = fs.readFileSync(filePath, "utf8");

    for (const tableName of removedStorageTables) {
      if (source.includes(`focowiki.${tableName}`)) {
        failures.push(`${path.relative(process.cwd(), filePath)}: ${tableName}`);
      }
    }
  }

  assert.deepEqual(failures, []);
});

test("runtime validation does not retain obsolete publication-mode helpers", () => {
  const failures = [];

  for (const filePath of collectRuntimeValidationFiles(validationRoot)) {
    const source = fs.readFileSync(filePath, "utf8");

    for (const symbol of obsoleteRuntimeSymbols) {
      if (source.includes(symbol)) {
        failures.push(`${path.relative(process.cwd(), filePath)}: ${symbol}`);
      }
    }
  }

  assert.deepEqual(failures, []);
});

test("API evidence scripts do not depend on removed storage tables", () => {
  const failures = [];

  for (const filePath of collectSourceFiles(apiScriptRoot)) {
    const source = fs.readFileSync(filePath, "utf8");

    for (const tableName of removedStorageTables) {
      if (source.includes(`focowiki.${tableName}`)) {
        failures.push(`${path.relative(process.cwd(), filePath)}: ${tableName}`);
      }
    }
  }

  assert.deepEqual(failures, []);
});

test("CI workflows do not invoke deleted API tests", () => {
  const failures = [];

  for (const filePath of fs.readdirSync(workflowRoot).map((name) => path.join(workflowRoot, name))) {
    if (!/\.ya?ml$/u.test(filePath)) continue;
    const source = fs.readFileSync(filePath, "utf8");
    for (const match of source.matchAll(/test\/[A-Za-z0-9._/-]+\.test\.ts/gu)) {
      const testPath = path.resolve("apps/api", match[0]);
      if (!fs.existsSync(testPath)) {
        failures.push(`${path.relative(process.cwd(), filePath)}: ${match[0]}`);
      }
    }
  }

  assert.deepEqual(failures, []);
});

function collectRuntimeValidationFiles(root) {
  return collectSourceFiles(root, new Set(["fixtures", "test"]));
}

function collectSourceFiles(root, excludedDirectories = new Set()) {
  const files = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();

    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) stack.push(entryPath);
      } else if (entry.isFile() && /\.(?:mjs|js|sh|ts)$/u.test(entry.name)) {
        files.push(entryPath);
      }
    }
  }

  return files.sort();
}
