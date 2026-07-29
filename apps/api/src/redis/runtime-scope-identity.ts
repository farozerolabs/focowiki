import { createHash } from "node:crypto";

export function createKnowledgeBaseRuntimeScopeIdentity(
  knowledgeBaseId: string
): string {
  return `knowledge-base-${createHash("sha256")
    .update(knowledgeBaseId)
    .digest("hex")
    .slice(0, 32)}`;
}
