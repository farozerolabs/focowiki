import { createHash } from "node:crypto";

export function createDocumentSourceRevisionPublicId(input: {
  knowledgeBaseId: string;
  sourceFilePublicId: string;
  checksum: string;
  variant?: string;
}): string {
  const digest = createHash("sha256")
    .update("document-source-revision-v1\0")
    .update(input.knowledgeBaseId)
    .update("\0")
    .update(input.sourceFilePublicId)
    .update("\0")
    .update(input.checksum)
    .update("\0")
    .update(input.variant ?? "content")
    .digest("hex");
  return `source-revision-${digest}`;
}
