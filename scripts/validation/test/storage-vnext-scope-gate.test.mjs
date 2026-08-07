import assert from "node:assert/strict";
import test from "node:test";

import {
  STORAGE_VNEXT_ALLOWLIST,
  classifyStorageVnextPath,
  validatePackageJsonScope,
  validateSettingsFieldPatch,
  validateStorageVnextScope
} from "../storage-vnext-scope-gate.mjs";

test("allows backend storage, tests, validation, and deployment files", () => {
  const paths = [
    "apps/api/src/infrastructure/postgres/source-file-repository.ts",
    "apps/api/src/application/ports/source-file-repository.ts",
    "apps/api/src/runtime-settings/types.ts",
    "apps/api/migrations/001_storage_vnext.sql",
    "apps/api/test/storage-vnext.test.ts",
    "scripts/deployment/storage-vnext-backup.mjs",
    "scripts/validation/storage-vnext-capacity.mjs",
    "deploy/docker/entrypoint.sh",
    "Dockerfile",
    "docker-compose.local.yml",
    ".github/workflows/ci.yml"
  ];

  assert.deepEqual(validateStorageVnextScope(paths), []);
});

test("rejects frozen and unrelated surfaces", () => {
  const paths = [
    "apps/admin/src/pages/AdminHomePage.tsx",
    "apps/admin/src/styles.css",
    "apps/admin/src/i18n/resources.ts",
    "apps/admin/src/components/ui/button.tsx",
    "apps/api/src/developer-openapi/openapi-paths.ts",
    "apps/api/src/okf/publication-files.ts",
    "apps/api/src/public-generated-path.ts",
    "apps/api/src/publication/directory-navigation-writer.ts",
    "packages/okf/src/public-bundle-path.ts",
    "docs/openapi/index.md",
    "README.md",
    "pnpm-lock.yaml",
    "apps/admin/package.json"
  ];

  const allowlist = structuredClone(STORAGE_VNEXT_ALLOWLIST);
  allowlist.explicitExceptions = [];
  const failures = validateStorageVnextScope(paths, allowlist);
  assert.equal(failures.length, paths.length);
  assert.deepEqual(failures.map((failure) => failure.path), paths);
});

test("recognizes only the two exact Admin settings-field files", () => {
  assert.equal(
    classifyStorageVnextPath("apps/admin/src/components/settings-panel.tsx").policy,
    "settings-field"
  );
  assert.equal(
    classifyStorageVnextPath("apps/admin/src/lib/admin-api.ts").policy,
    "settings-field"
  );
  assert.equal(
    classifyStorageVnextPath("apps/admin/src/pages/SettingsPage.tsx").policy,
    "deny"
  );
  assert.equal(
    classifyStorageVnextPath("apps/admin/test/settings-panel.test.tsx").policy,
    "allow"
  );
});

test("accepts only the reviewed complete patch fingerprint for a settings-field file", () => {
  const path = "apps/admin/src/components/settings-panel.tsx";
  const allowlist = structuredClone(STORAGE_VNEXT_ALLOWLIST);
  allowlist.settingsFieldFiles[path].approvedPatchSha256 =
    "9e00ec76c84ee98e4f509cbe76b55632c39c269e6003878697870af653765585";

  assert.deepEqual(validateSettingsFieldPatch({
    path,
    baselineSource: "export function SettingsPanel() {}",
    currentSource: "export function SettingsPanel() { return null; }",
    patch: "reviewed field patch"
  }, allowlist), []);

  assert.notDeepEqual(validateSettingsFieldPatch({
    path,
    baselineSource: "export function SettingsPanel() {}",
    currentSource: "export function SettingsPanel() { return null; }",
    patch: [
      "@@ -1,1 +1,1 @@",
      "-export function SettingsPanel() {}",
      "+export function SettingsPanel() { return null; }"
    ].join("\n")
  }, allowlist), []);
});

test("requires complete task and approval metadata for a frozen-surface exception", () => {
  const path = "apps/api/src/okf/publication-files.ts";
  const incomplete = structuredClone(STORAGE_VNEXT_ALLOWLIST);
  incomplete.explicitExceptions = [{ path, taskId: "8.4" }];
  assert.equal(classifyStorageVnextPath(path, incomplete).policy, "deny");

  const complete = structuredClone(STORAGE_VNEXT_ALLOWLIST);
  complete.explicitExceptions = [{
    path,
    taskId: "8.4",
    approvalReference: "user-approval-reference",
    reason: "Required internal writer adaptation",
    preservedContract: "No generated logical path or navigation change"
  }];
  assert.equal(classifyStorageVnextPath(path, complete).policy, "allow");
});

test("allows only the approved progressive-navigation frozen surfaces", () => {
  const approvedPaths = [
    "apps/api/src/publication/directory-navigation-writer.ts",
    "apps/api/src/publication/ordered-directory-leaves.ts",
    "docs/guide/file-cleaning-ingestion.md",
    "docs/guide/open-knowledge-format.md",
    "docs/zh-CN/guide/file-cleaning-ingestion.md",
    "docs/zh-CN/guide/open-knowledge-format.md",
    "packages/okf/src/concept-descriptors.ts",
    "packages/okf/src/concept-validation.ts",
    "packages/okf/src/public-bundle-path.ts",
    "packages/okf/src/source-path.ts"
  ];

  for (const path of approvedPaths) {
    assert.deepEqual(
      classifyStorageVnextPath(path),
      {
        policy: "allow",
        category: "explicit-task-exception",
        exception: STORAGE_VNEXT_ALLOWLIST.explicitExceptions.find(
          (exception) => exception.path === path
        )
      }
    );
  }

  assert.equal(
    classifyStorageVnextPath("docs/guide/unrelated.md").policy,
    "deny"
  );
  assert.equal(
    classifyStorageVnextPath("packages/okf/src/unrelated.ts").policy,
    "deny"
  );
});

test("allows an existing settings field-list edit", () => {
  const before = [
    "const workerNumberFields = [",
    "  \"legacyRetentionDays\",",
    "  \"claimBatchSize\"",
    "] as const;",
    "",
    "export function SettingsPanel() {",
    "  return <div className=\"grid\" />;",
    "}"
  ].join("\n");
  const after = [
    "const workerNumberFields = [",
    "  \"claimBatchSize\"",
    "] as const;",
    "",
    "export function SettingsPanel() {",
    "  return <div className=\"grid\" />;",
    "}"
  ].join("\n");
  const patch = [
    "@@ -1,4 +1,3 @@",
    " const workerNumberFields = [",
    "-  \"legacyRetentionDays\",",
    "   \"claimBatchSize\"",
    " ] as const;"
  ].join("\n");

  assert.deepEqual(validateSettingsFieldPatch({
    path: "apps/admin/src/components/settings-panel.tsx",
    baselineSource: before,
    currentSource: after,
    patch
  }), []);
});

test("rejects settings presentation and copy-call edits", () => {
  const before = [
    "const workerNumberFields = [\"claimBatchSize\"] as const;",
    "",
    "export function SettingsPanel() {",
    "  return <div className=\"grid\">{t(\"settings.title\")}</div>;",
    "}"
  ].join("\n");
  const after = before.replace("grid", "flex").replace("settings.title", "settings.newTitle");
  const patch = [
    "@@ -4,1 +4,1 @@",
    "-  return <div className=\"grid\">{t(\"settings.title\")}</div>;",
    "+  return <div className=\"flex\">{t(\"settings.newTitle\")}</div>;"
  ].join("\n");

  const failures = validateSettingsFieldPatch({
    path: "apps/admin/src/components/settings-panel.tsx",
    baselineSource: before,
    currentSource: after,
    patch
  });
  assert.equal(failures.length, 2);
  assert.ok(failures.every((failure) => failure.reason.includes("SettingsPanel")));
});

test("allows Admin API setting type fields and rejects unrelated symbols", () => {
  const before = [
    "export type WorkerSettings = {",
    "  legacyRetentionDays: number;",
    "  claimBatchSize: number;",
    "};",
    "",
    "export function setAdminAuthFailureHandler() {}"
  ].join("\n");
  const after = before.replace("  legacyRetentionDays: number;\n", "");
  const allowedPatch = [
    "@@ -1,4 +1,3 @@",
    " export type WorkerSettings = {",
    "-  legacyRetentionDays: number;",
    "   claimBatchSize: number;",
    " };"
  ].join("\n");
  assert.deepEqual(validateSettingsFieldPatch({
    path: "apps/admin/src/lib/admin-api.ts",
    baselineSource: before,
    currentSource: after,
    patch: allowedPatch
  }), []);

  const forbiddenAfter = after.replace(
    "export function setAdminAuthFailureHandler() {}",
    "export function setAdminAuthFailureHandler() { throw new Error(\"changed\"); }"
  );
  const forbiddenPatch = [
    "@@ -6,1 +6,1 @@",
    "-export function setAdminAuthFailureHandler() {}",
    "+export function setAdminAuthFailureHandler() { throw new Error(\"changed\"); }"
  ].join("\n");
  assert.equal(validateSettingsFieldPatch({
    path: "apps/admin/src/lib/admin-api.ts",
    baselineSource: after,
    currentSource: forbiddenAfter,
    patch: forbiddenPatch
  }).length, 2);
});

test("allows only storage-vNext validation scripts in the root package manifest", () => {
  const baseline = {
    name: "focowiki",
    scripts: { test: "vitest" },
    dependencies: { hono: "1.0.0" }
  };
  const allowed = {
    ...baseline,
    scripts: {
      ...baseline.scripts,
      "validate:storage-vnext:scope": "node scripts/validation/storage-vnext-scope-gate.mjs"
    }
  };
  assert.deepEqual(validatePackageJsonScope(baseline, allowed), []);

  const deploymentCommand = {
    ...baseline,
    scripts: {
      ...baseline.scripts,
      "compose:backup": "node scripts/deployment/storage-vnext-backup.mjs"
    }
  };
  assert.deepEqual(validatePackageJsonScope(baseline, deploymentCommand), []);

  const changedDeploymentCommand = {
    ...deploymentCommand,
    scripts: {
      ...deploymentCommand.scripts,
      "compose:backup": "node scripts/deployment/other-backup.mjs"
    }
  };
  assert.equal(validatePackageJsonScope(baseline, changedDeploymentCommand).length, 1);

  const dependencyChange = {
    ...allowed,
    dependencies: { ...allowed.dependencies, glob: "1.0.0" }
  };
  assert.equal(validatePackageJsonScope(baseline, dependencyChange).length, 1);

  const unrelatedScript = {
    ...baseline,
    scripts: { ...baseline.scripts, build: "changed" }
  };
  assert.equal(validatePackageJsonScope(baseline, unrelatedScript).length, 1);
});

test("CI executes the current storage-vNext scope and release gates", async () => {
  const ci = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8")
  );

  assert.match(
    ci,
    /- name: Checkout\n\s+uses: actions\/checkout@[^\n]+\n\s+with:\n\s+fetch-depth: 0/u
  );
  assert.match(ci, /pnpm validate:storage-vnext:scope/u);
  assert.match(ci, /pnpm validate:storage-vnext:release-gate/u);
});

test("settings patch fingerprints use stable full Git object IDs", async () => {
  const gate = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../storage-vnext-scope-gate.mjs", import.meta.url), "utf8")
  );

  assert.match(
    gate,
    /"diff", "--full-index", "--unified=0", "--no-ext-diff"/u
  );
});
