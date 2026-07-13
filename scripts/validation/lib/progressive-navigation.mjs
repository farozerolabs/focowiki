import path from "node:path";

const INLINE_LINK_PATTERN = /!?(?:\[[^\]\n]*\])\((<?[^\s)>]+>?)(?:\s+[^)]*)?\)/gu;

export function assertPagesReachableFromRootIndex({ bodies, pagePaths }) {
  const reachable = collectReachableMarkdownPaths(bodies, "index.md");
  for (const pagePath of pagePaths) {
    if (!reachable.has(pagePath)) {
      throw new Error(`Public index navigation cannot reach source-backed page: ${pagePath}`);
    }
  }
  return reachable;
}

export function collectReachableMarkdownPaths(bodies, startPath) {
  const reachable = new Set();
  const queued = [startPath];

  while (queued.length > 0) {
    const currentPath = queued.shift();
    if (!currentPath || reachable.has(currentPath) || !bodies.has(currentPath)) continue;
    reachable.add(currentPath);
    for (const target of readLocalMarkdownTargets(bodies.get(currentPath) ?? "", currentPath)) {
      if (bodies.has(target) && !reachable.has(target)) queued.push(target);
    }
  }

  return reachable;
}

function readLocalMarkdownTargets(markdown, currentPath) {
  const targets = [];
  for (const match of markdown.matchAll(INLINE_LINK_PATTERN)) {
    const target = resolveMarkdownTarget(match[1] ?? "", currentPath);
    if (target) targets.push(target);
  }
  return targets;
}

function resolveMarkdownTarget(rawTarget, currentPath) {
  const unwrapped = rawTarget.startsWith("<") && rawTarget.endsWith(">")
    ? rawTarget.slice(1, -1)
    : rawTarget;
  if (!unwrapped || unwrapped.startsWith("#") || /^[a-z][a-z0-9+.-]*:/iu.test(unwrapped)) {
    return null;
  }
  const withoutSuffix = unwrapped.split(/[?#]/u, 1)[0] ?? "";
  let decoded;
  try {
    decoded = decodeURIComponent(withoutSuffix);
  } catch {
    return null;
  }
  const joined = decoded.startsWith("/")
    ? decoded.slice(1)
    : path.posix.join(path.posix.dirname(currentPath), decoded);
  const normalized = path.posix.normalize(joined);
  return normalized === ".." || normalized.startsWith("../") || !normalized.endsWith(".md")
    ? null
    : normalized;
}
