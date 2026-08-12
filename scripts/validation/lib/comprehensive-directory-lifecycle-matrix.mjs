import path from "node:path";

export const DIRECTORY_LIFECYCLE_ACTIONS = Object.freeze([
  "list",
  "detail-read",
  "rename",
  "restore-after-rename",
  "move",
  "restore-after-move",
  "delete",
  "recreate",
  "final-detail-read"
]);

export function buildComprehensiveDirectoryLifecyclePlan(input) {
  const files = normalizeFiles(input.files);
  const expected = deriveExpectedDirectories(files);
  const observed = normalizeDirectories(input.directories);
  const observedByIdentity = new Map(observed.map((item) => [
    directoryIdentity(item.knowledgeBaseId, item.relativePath),
    item
  ]));
  if (
    observedByIdentity.size !== observed.length
    || new Set(observed.map((item) => item.directoryId)).size !== observed.length
  ) {
    throw new Error("Comprehensive directory identity is duplicated");
  }
  const familyByKnowledgeBase = new Map(files.map((item) => [
    item.knowledgeBaseId,
    item.alias.startsWith("official-") ? "official" : "legacy"
  ]));
  if (
    expected.some((item) => !observedByIdentity.has(item.identity))
    || observed.some((item) => !familyByKnowledgeBase.has(item.knowledgeBaseId))
  ) {
    throw new Error("Comprehensive directory coverage does not match source paths");
  }
  const plannedDirectories = observed.map((runtime) => {
    const expectedDirectory = expected.find((item) => item.identity === directoryIdentity(
      runtime.knowledgeBaseId,
      runtime.relativePath
    ));
    return {
      identity: directoryIdentity(runtime.knowledgeBaseId, runtime.relativePath),
      knowledgeBaseId: runtime.knowledgeBaseId,
      family: expectedDirectory?.family ?? familyByKnowledgeBase.get(runtime.knowledgeBaseId),
      relativePath: runtime.relativePath,
      depth: runtime.relativePath.split("/").length,
      runtime
    };
  }).sort(compareFamilyAndPath);
  const directories = plannedDirectories.map((item, index) => {
    const runtime = item.runtime;
    return {
      directoryAlias: `directory-${String(index + 1).padStart(3, "0")}`,
      knowledgeBaseId: item.knowledgeBaseId,
      family: item.family,
      directoryId: runtime.directoryId,
      parentDirectoryId: runtime.parentDirectoryId,
      relativePath: item.relativePath,
      depth: item.depth,
      resourceRevision: runtime.resourceRevision,
      descendantAliases: files
        .filter((file) => file.knowledgeBaseId === item.knowledgeBaseId
          && file.relativePath.startsWith(`${item.relativePath}/`))
        .map((file) => file.alias)
    };
  });
  const cases = directories.flatMap((directory) => DIRECTORY_LIFECYCLE_ACTIONS.map(
    (action) => {
      const applicable = !["move", "restore-after-move"].includes(action)
        || directory.depth > 1;
      return {
        id: `directory-case:${directory.directoryAlias}:${action}`,
        directoryAlias: directory.directoryAlias,
        action,
        applicable,
        skipReason: applicable ? null : "root_directory_has_no_distinct_move_parent",
        automatedStatus: "pending",
        manualStatus: "pending"
      };
    }
  ));
  return {
    kind: "focowiki-comprehensive-directory-lifecycle-plan",
    version: 1,
    generatedAt: new Date().toISOString(),
    files,
    directories,
    cases,
    counts: {
      files: files.length,
      directories: directories.length,
      cases: cases.length,
      applicableCases: cases.filter((item) => item.applicable).length,
      skippedCases: cases.filter((item) => !item.applicable).length
    }
  };
}

export function assertComprehensiveDirectoryLifecyclePlan(plan, options = {}) {
  const expectedFileCount = options.expectedFileCount ?? 200;
  const expectedDirectoryCount = options.expectedDirectoryCount;
  if (
    plan?.kind !== "focowiki-comprehensive-directory-lifecycle-plan"
    || plan.version !== 1
    || plan.files?.length !== expectedFileCount
    || new Set(plan.files.map((item) => item.alias)).size !== expectedFileCount
  ) {
    throw new Error("Comprehensive directory file cardinality mismatch");
  }
  if (
    !Array.isArray(plan.directories)
    || plan.directories.length === 0
    || expectedDirectoryCount !== undefined
      && plan.directories.length !== expectedDirectoryCount
    || new Set(plan.directories.map((item) => item.directoryAlias)).size
      !== plan.directories.length
  ) {
    throw new Error("Comprehensive directory cardinality mismatch");
  }
  const expectedCaseCount = plan.directories.length * DIRECTORY_LIFECYCLE_ACTIONS.length;
  if (
    plan.cases?.length !== expectedCaseCount
    || new Set(plan.cases.map((item) => item.id)).size !== expectedCaseCount
    || plan.cases.some((item) => item.id === "bulk-pass")
    || plan.directories.some((directory) => !sameActions(
      plan.cases.filter((item) => item.directoryAlias === directory.directoryAlias)
        .map((item) => item.action),
      DIRECTORY_LIFECYCLE_ACTIONS
    ))
    || plan.cases.some((item) => item.applicable === false && !item.skipReason)
  ) {
    throw new Error("Comprehensive directory case cardinality mismatch");
  }
  return plan;
}

function normalizeFiles(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("Comprehensive directory source files are empty");
  }
  const files = rows.map((row) => ({
    alias: String(row?.alias ?? ""),
    knowledgeBaseId: String(row?.knowledgeBaseId ?? ""),
    relativePath: normalizeRelativePath(row?.relativePath)
  }));
  if (
    new Set(files.map((item) => item.alias)).size !== files.length
    || files.some((item) => !/^(?:official|legacy)-\d{3}$/u.test(item.alias)
      || !/^knowledge-base-[a-z0-9-]+$/u.test(item.knowledgeBaseId)
      || !item.relativePath.endsWith(".md"))
  ) {
    throw new Error("Comprehensive directory source file identity is invalid");
  }
  return files.sort(compareFamilyAndPath);
}

function normalizeDirectories(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("Comprehensive directory runtime inventory is empty");
  }
  const directories = rows.map((row) => ({
    knowledgeBaseId: String(row?.knowledgeBaseId ?? ""),
    directoryId: String(row?.directoryId ?? ""),
    parentDirectoryId: row?.parentDirectoryId === null
      || row?.parentDirectoryId === undefined
      ? null
      : String(row.parentDirectoryId),
    relativePath: normalizeRelativePath(row?.relativePath),
    resourceRevision: Number(row?.resourceRevision)
  }));
  if (directories.some((item) =>
    !/^knowledge-base-[a-z0-9-]+$/u.test(item.knowledgeBaseId)
    || !/^directory-[a-z0-9-]+$/u.test(item.directoryId)
    || !Number.isSafeInteger(item.resourceRevision)
    || item.resourceRevision < 1)) {
    throw new Error("Comprehensive directory runtime identity is invalid");
  }
  return directories;
}

function deriveExpectedDirectories(files) {
  const byIdentity = new Map();
  for (const file of files) {
    const segments = path.posix.dirname(file.relativePath).split("/");
    for (let index = 1; index <= segments.length; index += 1) {
      const relativePath = segments.slice(0, index).join("/");
      const identity = directoryIdentity(file.knowledgeBaseId, relativePath);
      byIdentity.set(identity, {
        identity,
        knowledgeBaseId: file.knowledgeBaseId,
        family: file.alias.startsWith("official-") ? "official" : "legacy",
        relativePath,
        depth: index
      });
    }
  }
  return [...byIdentity.values()].sort(compareFamilyAndPath);
}

function compareFamilyAndPath(left, right) {
  return familyOrder(left.family) - familyOrder(right.family)
    || left.relativePath.split("/").length - right.relativePath.split("/").length
    || left.relativePath.localeCompare(right.relativePath, "en");
}

function familyOrder(family) {
  return family === "official" ? 0 : 1;
}

function normalizeRelativePath(value) {
  const candidate = String(value ?? "").normalize("NFC").replaceAll("\\", "/");
  if (
    !candidate
    || candidate.startsWith("/")
    || candidate.endsWith("/")
    || candidate.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("Comprehensive directory relative path is invalid");
  }
  return candidate;
}

function directoryIdentity(knowledgeBaseId, relativePath) {
  return `${knowledgeBaseId}\0${relativePath}`;
}

function sameActions(actual, expected) {
  return actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}
