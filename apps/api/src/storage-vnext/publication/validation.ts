import { posix } from "node:path";
import { isAllowedPublicGeneratedFilePath } from "../../public-generated-path.js";
import { REQUIRED_GENERATED_NAVIGATION_PATHS } from
  "../../okf/generated-graph-resources.js";
import type { StorageVnextPublicationArtifact } from "./types.js";

export const STORAGE_VNEXT_RELEASED_NAVIGATION_PATHS = Object.freeze(
  [...REQUIRED_GENERATED_NAVIGATION_PATHS]
);

export function validateStorageVnextReleasedStructure(input: {
  artifacts: readonly StorageVnextPublicationArtifact[];
  expectedSourceMappings: readonly {
    sourceFilePublicId: string;
    logicalPath: string;
  }[];
  expectedDirectoryPaths: readonly string[];
}): { logicalPaths: string[]; linkCount: number; sourceMappingCount: number } {
  const ordered = [...input.artifacts].sort((left, right) => left.ordinal - right.ordinal);
  const paths = ordered.map((artifact) => artifact.logicalPath);
  if (new Set(paths).size !== paths.length) {
    throw new Error("Storage vNext publication contains duplicate logical paths");
  }
  if (new Set(ordered.map((artifact) => artifact.ordinal)).size !== ordered.length) {
    throw new Error("Storage vNext publication contains duplicate ordinals");
  }
  if (paths.some((path) => !isAllowedPublicGeneratedFilePath(path))) {
    throw new Error("Storage vNext publication contains a noncanonical public path");
  }
  if (STORAGE_VNEXT_RELEASED_NAVIGATION_PATHS.some((path, index) => paths[index] !== path)) {
    throw new Error("Storage vNext required navigation order changed");
  }

  const expectedDirectories = input.expectedDirectoryPaths.map((path) =>
    `${path}/index.md`
  );
  if (expectedDirectories.some((path) => !paths.includes(path))) {
    throw new Error("Storage vNext directory navigation is incomplete");
  }
  const actualSources = ordered
    .filter((artifact) => artifact.kind === "source")
    .map((artifact) => ({
      sourceFilePublicId: artifact.sourceFilePublicId!,
      logicalPath: artifact.logicalPath
    }));
  if (
    JSON.stringify(actualSources) !== JSON.stringify(input.expectedSourceMappings)
    || actualSources.some((source) => !source.logicalPath.startsWith("pages/"))
  ) {
    throw new Error("Storage vNext source-backed mapping changed");
  }

  const pathSet = new Set(paths);
  let linkCount = 0;
  for (const artifact of ordered) {
    if (!artifact.logicalPath.endsWith(".md")) continue;
    const body = Buffer.from(artifact.bytes).toString("utf8");
    for (const resolved of resolveStorageVnextMarkdownTargets(artifact.logicalPath, body)) {
      linkCount += 1;
      if (resolved && !pathSet.has(resolved)) {
        throw new Error(`Storage vNext Markdown link target is missing: ${resolved}`);
      }
    }
  }
  return {
    logicalPaths: paths,
    linkCount,
    sourceMappingCount: actualSources.length
  };
}

export function resolveStorageVnextMarkdownTargets(
  sourcePath: string,
  body: string
): string[] {
  return extractMarkdownLinkTargets(body)
    .filter((target) => !/^(?:https?:|mailto:|#)/iu.test(target))
    .map((target) => resolveTarget(sourcePath, target))
    .filter((target): target is string => target !== null);
}

function extractMarkdownLinkTargets(body: string): string[] {
  const targets: string[] = [];
  let searchFrom = 0;
  while (searchFrom < body.length) {
    const opening = body.indexOf("](", searchFrom);
    if (opening === -1) break;
    const targetStart = opening + 2;
    let depth = 1;
    let escaped = false;
    let closed = false;
    for (let index = targetStart; index < body.length; index += 1) {
      const character = body[index]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === "(") {
        depth += 1;
        continue;
      }
      if (character !== ")") continue;
      depth -= 1;
      if (depth !== 0) continue;
      targets.push(body.slice(targetStart, index));
      searchFrom = index + 1;
      closed = true;
      break;
    }
    if (!closed) searchFrom = targetStart;
  }
  return targets;
}

function resolveTarget(sourcePath: string, target: string): string | null {
  const withoutFragment = target.split("#", 1)[0];
  if (!withoutFragment) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutFragment);
  } catch {
    throw new Error("Storage vNext Markdown link target is malformed");
  }
  return decoded.startsWith("/")
    ? decoded.slice(1)
    : posix.normalize(posix.join(posix.dirname(sourcePath), decoded));
}
