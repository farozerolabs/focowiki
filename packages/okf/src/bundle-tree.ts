export type BundleTreeFile = {
  id: string;
  logicalPath: string;
};

export type BundleTreeEntryType = "directory" | "file";

export type BundleTreeEntryDraft = {
  entryType: BundleTreeEntryType;
  parentPath: string;
  name: string;
  logicalPath: string;
  bundleFileId: string | null;
};

export type BundleTreeEntry = BundleTreeEntryDraft & {
  id: string;
  knowledgeBaseId: string;
  releaseId: string;
};

export type BuildBundleTreeEntriesInput = {
  knowledgeBaseId: string;
  releaseId: string;
  files: BundleTreeFile[];
  createId?: (entry: BundleTreeEntryDraft) => string;
};

const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

export function buildBundleTreeEntries(input: BuildBundleTreeEntriesInput): BundleTreeEntry[] {
  const entries: BundleTreeEntry[] = [];
  const seenDirectories = new Set<string>();
  let nextId = 0;

  const createId =
    input.createId ??
    (() => {
      nextId += 1;
      return `bundle-tree-entry-${String(nextId).padStart(6, "0")}`;
    });

  for (const file of input.files) {
    const logicalPath = normalizeLogicalPath(file.logicalPath);
    const segments = logicalPath.split("/");

    for (let index = 0; index < segments.length - 1; index += 1) {
      const directoryPath = segments.slice(0, index + 1).join("/");

      if (seenDirectories.has(directoryPath)) {
        continue;
      }

      seenDirectories.add(directoryPath);
      entries.push(
        finalizeEntry(input, createId, {
          entryType: "directory",
          parentPath: segments.slice(0, index).join("/"),
          name: segments[index] ?? "",
          logicalPath: directoryPath,
          bundleFileId: null
        })
      );
    }

    entries.push(
      finalizeEntry(input, createId, {
        entryType: "file",
        parentPath: segments.slice(0, -1).join("/"),
        name: segments.at(-1) ?? "",
        logicalPath,
        bundleFileId: file.id
      })
    );
  }

  return entries;
}

function finalizeEntry(
  input: Pick<BuildBundleTreeEntriesInput, "knowledgeBaseId" | "releaseId">,
  createId: (entry: BundleTreeEntryDraft) => string,
  draft: BundleTreeEntryDraft
): BundleTreeEntry {
  return {
    id: createId(draft),
    knowledgeBaseId: input.knowledgeBaseId,
    releaseId: input.releaseId,
    ...draft
  };
}

function normalizeLogicalPath(rawPath: string): string {
  const decoded = decodeForValidation(rawPath).replace(/^\/+|\/+$/g, "");
  const segments = decoded.split("/");

  if (segments.length === 0 || segments.some((segment) => !isSafeSegment(segment))) {
    throw new Error("Bundle tree logical path must be a safe relative path");
  }

  return segments.join("/");
}

function isSafeSegment(segment: string): boolean {
  return (
    SAFE_SEGMENT_PATTERN.test(segment) &&
    segment !== "." &&
    segment !== ".." &&
    !segment.includes("..") &&
    !segment.includes("\\") &&
    !segment.includes("/")
  );
}

function decodeForValidation(value: string): string {
  let decoded = value.trim();

  for (let index = 0; index < 3; index += 1) {
    try {
      const next = decodeURIComponent(decoded);

      if (next === decoded) {
        return next;
      }

      decoded = next;
    } catch {
      throw new Error("Bundle tree logical path contains invalid percent encoding");
    }
  }

  return decoded;
}
