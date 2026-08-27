import { createDirectoryLeafId } from
  "./production-document-processor-support.js";

export function createDirectoryLeafIdFactory(input: Readonly<{
  prefix: "directory-leaf" | "extension-leaf";
  knowledgeBaseId: string;
  directoryPath: string;
  occupiedLeafIds: readonly string[];
  persistedOccupiedLeafIds?: unknown;
}>): () => string {
  const persisted = input.persistedOccupiedLeafIds;
  if (persisted !== undefined && (!Array.isArray(persisted)
    || persisted.some((leafId) => typeof leafId !== "string" || !leafId))) {
    throw leafIdentityError("directory_leaf_occupancy_invalid");
  }
  const occupiedLeafIds = new Set([
    ...input.occupiedLeafIds,
    ...(persisted as readonly string[] | undefined ?? [])
  ]);
  let sequence = 0;
  return () => createDirectoryLeafId({
    prefix: input.prefix,
    knowledgeBaseId: input.knowledgeBaseId,
    directoryPath: input.directoryPath,
    occupiedLeafIds,
    sequence: ++sequence
  });
}

function leafIdentityError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Directory leaf identity error: ${code}`), {
    code
  });
}
