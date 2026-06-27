import { createHash } from "node:crypto";

export function createKnowledgeBaseCursorScope(query: string | null): string {
  if (!query) {
    return "knowledge-bases";
  }

  return ["knowledge-bases", `query-${createKnowledgeBaseSearchSignature(query)}`].join(":");
}

export function createKnowledgeBaseSearchSignature(query: string): string {
  return createHash("sha256")
    .update(query.trim().toLocaleLowerCase("en-US"))
    .digest("hex")
    .slice(0, 32);
}
