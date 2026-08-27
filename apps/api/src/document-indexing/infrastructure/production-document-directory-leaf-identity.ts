import { createDirectoryLeafId } from
  "./production-document-processor-support.js";

export function createDirectoryLeafIdFactory(input: Readonly<{
  prefix: "directory-leaf" | "extension-leaf";
  knowledgeBaseId: string;
  directoryPath: string;
  occupiedLeafIds: readonly string[];
}>): () => string {
  const occupiedLeafIds = new Set(input.occupiedLeafIds);
  let sequence = 0;
  return () => createDirectoryLeafId({
    prefix: input.prefix,
    knowledgeBaseId: input.knowledgeBaseId,
    directoryPath: input.directoryPath,
    occupiedLeafIds,
    sequence: ++sequence
  });
}
