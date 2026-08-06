import path from "node:path";

const MARKDOWN_LINK = /\]\(([^)\n]+?\.md)(?:#[^)\n]*)?\)/giu;

export function selectClosedMarkdownSample(input) {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
    throw new Error("Invalid closed Markdown sample limit.");
  }
  const filePaths = [...new Set(input.filePaths)].sort((left, right) =>
    left.localeCompare(right)
  );
  const known = new Set(filePaths);
  const byBasename = new Map();
  for (const filePath of filePaths) {
    const basename = path.basename(filePath);
    const matches = byBasename.get(basename) ?? [];
    matches.push(filePath);
    byBasename.set(basename, matches);
  }
  const edges = new Map();
  const invalid = new Set();
  for (const filePath of filePaths) {
    const targets = [];
    for (const match of input.readText(filePath).matchAll(MARKDOWN_LINK)) {
      const target = resolveTarget(filePath, match[1], known, byBasename);
      if (!target) {
        invalid.add(filePath);
        continue;
      }
      targets.push(target);
    }
    edges.set(filePath, [...new Set(targets)].sort((left, right) =>
      left.localeCompare(right)
    ));
  }
  const closures = filePaths
    .map((filePath) => closure(filePath, edges, invalid, input.limit))
    .filter((value) => value !== null)
    .sort((left, right) => left.length - right.length
      || left[0].localeCompare(right[0]));
  const selected = new Set();
  for (const candidate of closures) {
    const additions = candidate.filter((filePath) => !selected.has(filePath));
    if (selected.size + additions.length > input.limit) continue;
    for (const filePath of additions) selected.add(filePath);
    if (selected.size === input.limit) break;
  }
  if (selected.size !== input.limit) {
    throw new Error(`Unable to select a ${input.limit}-file closed Markdown sample.`);
  }
  return [...selected].sort((left, right) => left.localeCompare(right));
}

function closure(start, edges, invalid, limit) {
  const selected = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift();
    if (invalid.has(current)) return null;
    for (const target of edges.get(current) ?? []) {
      if (selected.has(target)) continue;
      selected.add(target);
      if (selected.size > limit) return null;
      queue.push(target);
    }
  }
  return [...selected].sort((left, right) => left.localeCompare(right));
}

function resolveTarget(sourcePath, encodedTarget, known, byBasename) {
  let decodedTarget;
  try {
    decodedTarget = decodeURIComponent(encodedTarget);
  } catch {
    return null;
  }
  const resolved = path.resolve(path.dirname(sourcePath), decodedTarget);
  if (known.has(resolved)) return resolved;
  const matches = byBasename.get(path.basename(decodedTarget)) ?? [];
  return matches.length === 1 ? matches[0] : null;
}
