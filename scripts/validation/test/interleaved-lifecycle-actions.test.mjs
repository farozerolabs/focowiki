import assert from "node:assert/strict";
import test from "node:test";
import {
  MAINTENANCE_CASES,
  buildMaintenancePrecondition,
  buildModificationRequest,
  buildProjectionAmplificationPath,
  selectLifecycleCases
} from "../lib/interleaved-lifecycle-actions.mjs";
import {
  MODIFICATION_CASES
} from "../lib/interleaved-lifecycle-matrix.mjs";

const context = {
  runId: "validation-run-1",
  scenarioId: "modification-during-upload",
  sequence: 2,
  knowledgeBaseId: "kb-owned",
  knowledgeBaseRevision: 7,
  sourceFile: {
    sourceFileId: "source-file-1",
    resourceRevision: 9,
    relativePath: "baseline/nested/source.md"
  },
  directory: {
    directoryId: "source-directory-1",
    resourceRevision: 11,
    relativePath: "baseline/nested"
  },
  replacementBody: Buffer.from("# Replacement\n")
};

test("builds one production-contract request for every modification kind", () => {
  const requests = Object.fromEntries(
    MODIFICATION_CASES.map((kind) => [
      kind,
      buildModificationRequest({ kind, ...context })
    ])
  );

  assert.deepEqual(
    Object.keys(requests),
    MODIFICATION_CASES
  );
  assert.equal(requests["source-content-replace"].method, "PUT");
  assert.equal(
    requests["source-content-replace"].pathname,
    "/openapi/v2/knowledge-bases/kb-owned/source-files/source-file-1/content"
  );
  assert.equal(requests["source-file-rename"].method, "PATCH");
  assert.equal(
    requests["source-file-rename"].json.relativePath,
    "baseline/nested/renamed-2.md"
  );
  assert.equal(
    requests["source-file-move"].json.relativePath,
    "moved/modification-during-upload/source-2.md"
  );
  assert.equal(
    requests["source-directory-rename"].json.relativePath,
    "baseline/renamed-directory-2"
  );
  assert.equal(
    requests["source-directory-move"].json.relativePath,
    "moved/modification-during-upload/directory-2"
  );
  assert.equal(
    requests["knowledge-base-metadata-update"].pathname,
    "/openapi/v2/knowledge-bases/kb-owned"
  );
  assert.deepEqual(
    requests["knowledge-base-metadata-update"].json,
    {
      name: "Interleaved modification-during-upload 2",
      description: "Lifecycle validation update 2"
    }
  );

  for (const request of Object.values(requests)) {
    assert.match(request.headers["if-match"], /^"\d+"$/u);
  }
});

test("builds isolated maintenance preconditions and rejects unowned resources", () => {
  const ownedKnowledgeBaseIds = new Set(["kb-owned"]);
  const projection = buildMaintenancePrecondition({
    kind: "projection-repair",
    knowledgeBaseId: "kb-owned",
    runId: "validation-run-1",
    ownedKnowledgeBaseIds,
    s3Prefix: "test-prefix"
  });
  const lexical = buildMaintenancePrecondition({
    kind: "lexical-rebuild",
    knowledgeBaseId: "kb-owned",
    runId: "validation-run-1",
    ownedKnowledgeBaseIds,
    s3Prefix: "test-prefix"
  });
  const compaction = buildMaintenancePrecondition({
    kind: "projection-compaction",
    knowledgeBaseId: "kb-owned",
    runId: "validation-run-1",
    ownedKnowledgeBaseIds,
    s3Prefix: "test-prefix"
  });
  const reconciliation = buildMaintenancePrecondition({
    kind: "storage-reconciliation",
    knowledgeBaseId: "kb-owned",
    runId: "validation-run-1",
    ownedKnowledgeBaseIds,
    s3Prefix: "test-prefix"
  });

  assert.deepEqual(MAINTENANCE_CASES, [
    "projection-repair",
    "lexical-rebuild",
    "projection-compaction",
    "storage-reconciliation"
  ]);
  assert.deepEqual(projection, {
    kind: "projection-repair",
    strategy: "invalidate-run-owned-projection-version",
    knowledgeBaseId: "kb-owned",
    projectionKind: "tree"
  });
  assert.deepEqual(lexical, {
    kind: "lexical-rebuild",
    strategy: "invalidate-run-owned-lexical-version",
    knowledgeBaseId: "kb-owned",
    staleVersion: "validation-validation-run-1"
  });
  assert.deepEqual(compaction, {
    kind: "projection-compaction",
    strategy: "natural-segment-amplification",
    knowledgeBaseId: "kb-owned",
    requiredActiveSegmentCount: 9
  });
  assert.deepEqual(reconciliation, {
    kind: "storage-reconciliation",
    strategy: "advance-existing-cycle",
    knowledgeBaseId: "kb-owned",
    prefix: "test-prefix/generated/"
  });

  assert.throws(
    () => buildMaintenancePrecondition({
      kind: "projection-repair",
      knowledgeBaseId: "kb-not-owned",
      runId: "validation-run-1",
      ownedKnowledgeBaseIds,
      s3Prefix: "test-prefix"
    }),
    /not owned by this validation run/u
  );
});

test("distributes all modification and maintenance cases across the matrix", () => {
  const selected = Array.from({ length: 60 }, (_, index) =>
    selectLifecycleCases(index)
  );

  assert.deepEqual(
    new Set(selected.map((item) => item.modificationKind)),
    new Set(MODIFICATION_CASES)
  );
  assert.deepEqual(
    new Set(selected.map((item) => item.maintenanceKind)),
    new Set(MAINTENANCE_CASES)
  );
  assert.deepEqual(
    new Set(selected.map((item) => item.deletionKind)),
    new Set(["source-file", "source-directory", "task", "knowledge-base"])
  );
});

test("keeps projection amplification moves inside an existing directory", () => {
  assert.equal(
    buildProjectionAmplificationPath(3),
    "baseline/compaction-source-3.md"
  );
});
