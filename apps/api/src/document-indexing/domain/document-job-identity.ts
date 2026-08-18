import { createHash } from "node:crypto";

export function createDocumentJobPublicId(input: {
  knowledgeBaseId: string;
  sourceRevisionPublicId: string;
}): string {
  assertIdentity(input.knowledgeBaseId, "knowledge base");
  assertIdentity(input.sourceRevisionPublicId, "source revision");
  const digest = createHash("sha256")
    .update("focowiki-document-job-v1\0")
    .update(input.knowledgeBaseId)
    .update("\0")
    .update(input.sourceRevisionPublicId)
    .digest("hex");
  return `document-job-${digest}`;
}

function assertIdentity(value: string, label: string): void {
  if (!value || Buffer.byteLength(value, "utf8") > 255) {
    throw new Error(`Document job ${label} identity is invalid`);
  }
}
