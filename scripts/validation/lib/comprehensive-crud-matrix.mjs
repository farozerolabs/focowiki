export const CRUD_FILE_ACTIONS = Object.freeze([
  "list",
  "detail-read",
  "content-read",
  "preview-read",
  "duplicate-upload",
  "cancel-upload",
  "rename",
  "rename-idempotent-replay",
  "move",
  "move-idempotent-replay",
  "restore-path",
  "replace-content",
  "replace-content-idempotent-replay",
  "restore-content",
  "controlled-source-failure",
  "terminal-retry",
  "restore-after-retry",
  "delete",
  "delete-idempotent-replay",
  "recreate",
  "final-detail-read",
  "final-content-read",
  "final-preview-read"
]);

export const CRUD_MUTATION_ACTIONS = Object.freeze([
  "duplicate-upload",
  "cancel-upload",
  "rename",
  "rename-idempotent-replay",
  "move",
  "move-idempotent-replay",
  "restore-path",
  "replace-content",
  "replace-content-idempotent-replay",
  "restore-content",
  "controlled-source-failure",
  "terminal-retry",
  "restore-after-retry",
  "delete",
  "delete-idempotent-replay",
  "recreate"
]);

export function buildComprehensiveCrudPlan(corpusRows) {
  const files = normalizeCorpus(corpusRows);
  const cases = files.flatMap((file) => CRUD_FILE_ACTIONS.map((action) => ({
    id: `crud-case:${file.alias}:${action}`,
    alias: file.alias,
    family: file.family,
    action,
    expectedChecksumSha256: file.checksumSha256,
    automatedStatus: "pending",
    manualStatus: "pending"
  })));
  const dispositions = files.flatMap((mutationFile) =>
    CRUD_MUTATION_ACTIONS.flatMap((action) => files.map((observedFile) => ({
      id: `crud-impact:${mutationFile.alias}:${action}:${observedFile.alias}`,
      mutationAlias: mutationFile.alias,
      action,
      observedAlias: observedFile.alias,
      expectedDisposition: expectedDisposition({
        mutationAlias: mutationFile.alias,
        observedAlias: observedFile.alias,
        action
      })
    }))));
  return {
    kind: "focowiki-comprehensive-crud-plan",
    version: 1,
    generatedAt: new Date().toISOString(),
    files,
    cases,
    dispositions,
    counts: {
      files: files.length,
      cases: cases.length,
      mutationActions: files.length * CRUD_MUTATION_ACTIONS.length,
      dispositions: dispositions.length
    }
  };
}

export function assertComprehensiveCrudPlan(plan, options = {}) {
  const expectedFileCount = options.expectedFileCount ?? 200;
  if (
    plan?.kind !== "focowiki-comprehensive-crud-plan"
    || plan.version !== 1
    || plan.files?.length !== expectedFileCount
    || new Set(plan.files?.map((file) => file.alias)).size !== expectedFileCount
  ) {
    throw new Error("CRUD file cardinality mismatch");
  }
  const expectedCases = expectedFileCount * CRUD_FILE_ACTIONS.length;
  if (
    plan.cases?.length !== expectedCases
    || new Set(plan.cases.map((item) => item.id)).size !== expectedCases
    || plan.files.some((file) => !sameActions(
      plan.cases.filter((item) => item.alias === file.alias).map((item) => item.action),
      CRUD_FILE_ACTIONS
    ))
  ) {
    throw new Error("CRUD case cardinality mismatch");
  }
  const expectedDispositions = expectedFileCount
    * CRUD_MUTATION_ACTIONS.length
    * expectedFileCount;
  if (
    plan.dispositions?.length !== expectedDispositions
    || new Set(plan.dispositions.map((item) => item.id)).size !== expectedDispositions
    || plan.dispositions.some((item) => item.id === "bulk-pass")
  ) {
    throw new Error("CRUD impact cardinality mismatch");
  }
  return plan;
}

function normalizeCorpus(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("CRUD corpus is empty");
  }
  const files = rows.map((row) => ({
    alias: String(row?.alias ?? ""),
    family: String(row?.family ?? ""),
    checksumSha256: String(row?.checksumSha256 ?? "")
  }));
  if (
    new Set(files.map((file) => file.alias)).size !== files.length
    || files.some((file) =>
      !/^(?:official|legacy)-\d{3}$/u.test(file.alias)
      || !["official", "legacy"].includes(file.family)
      || !/^[a-f0-9]{64}$/u.test(file.checksumSha256))
  ) {
    throw new Error("CRUD corpus contains an invalid identity");
  }
  return files.sort((left, right) =>
    familyOrder(left.family) - familyOrder(right.family)
    || left.alias.localeCompare(right.alias));
}

function familyOrder(family) {
  return family === "official" ? 0 : 1;
}

function expectedDisposition({ mutationAlias, observedAlias, action }) {
  if (mutationAlias !== observedAlias) return "intentionally-unchanged";
  if ([
    "duplicate-upload",
    "cancel-upload",
    "rename-idempotent-replay",
    "move-idempotent-replay",
    "replace-content-idempotent-replay",
    "restore-after-retry"
  ].includes(action)) return "intentionally-unchanged";
  if (["delete", "delete-idempotent-replay"].includes(action)) return "deleted";
  return "affected";
}

function sameActions(actual, expected) {
  return actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}
