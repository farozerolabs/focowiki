export type DesiredGeneratedPage = {
  logicalPath: string;
  normalizedPath: string;
  checksumSha256: string;
  byteCount: number;
};

export function selectAffectedGeneratedPaths(input: {
  changedSourceLogicalPaths: readonly string[];
  oldSourceLogicalPaths: readonly string[];
  affectedGraphPaths: readonly string[];
  affectedLeafPaths: readonly string[];
  includeManifest: boolean;
  includeLog: boolean;
}): string[] {
  const paths = new Set<string>([
    "index.md", "pages/index.md", "_index/index.md", "_graph/index.md"
  ]);
  if (input.includeManifest) paths.add("_index/catalog.json");
  if (input.includeLog) paths.add("log.md");
  for (const sourcePath of [
    ...input.changedSourceLogicalPaths,
    ...input.oldSourceLogicalPaths
  ]) {
    validateSourcePath(sourcePath);
    paths.add(`pages/${sourcePath}`);
    const segments = sourcePath.split("/").slice(0, -1);
    for (let depth = 1; depth <= segments.length; depth += 1) {
      paths.add(`pages/${segments.slice(0, depth).join("/")}/index.md`);
    }
  }
  for (const path of [...input.affectedGraphPaths, ...input.affectedLeafPaths]) {
    validateGeneratedPath(path);
    paths.add(path);
  }
  return [...paths].sort(compareText);
}

export function planGeneratedPageWrites(input: {
  desired: readonly DesiredGeneratedPage[];
  current: readonly {
    logicalPath: string;
    normalizedPath: string;
    checksumSha256: string;
    objectId: string;
  }[];
  affectedNormalizedPaths: readonly string[];
}) {
  const affected = new Set(input.affectedNormalizedPaths);
  const current = new Map(input.current.map((item) => [item.normalizedPath, item]));
  const desired = new Map(input.desired.map((item) => [item.normalizedPath, item]));
  if (affected.size > 10_000 || current.size !== input.current.length
    || desired.size !== input.desired.length
    || [...desired.keys()].some((path) => !affected.has(path))) {
    throw pagePlanError("input_invalid");
  }
  const write: DesiredGeneratedPage[] = [];
  const reuse: Array<DesiredGeneratedPage & { objectId: string }> = [];
  const remove: string[] = [];
  for (const page of input.desired) {
    const active = current.get(page.normalizedPath);
    if (active?.checksumSha256 === page.checksumSha256) {
      reuse.push({ ...page, objectId: active.objectId });
    } else write.push(page);
  }
  for (const path of affected) {
    if (current.has(path) && !desired.has(path)) remove.push(path);
  }
  return {
    write: write.sort(comparePage),
    reuse: reuse.sort(comparePage),
    remove: remove.sort(compareText)
  };
}

function validateSourcePath(value: string): void {
  if (!value || value.startsWith("/") || !value.toLowerCase().endsWith(".md")
    || value.includes("..") || value.includes("\\")) {
    throw pagePlanError("source_path_invalid");
  }
}

function validateGeneratedPath(value: string): void {
  if (!value || value.startsWith("/") || value.includes("..")
    || value.includes("\\")) throw pagePlanError("generated_path_invalid");
}

function comparePage(
  left: { normalizedPath: string }, right: { normalizedPath: string }
): number {
  return compareText(left.normalizedPath, right.normalizedPath);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function pagePlanError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Generated page plan error: ${code}`), { code });
}
