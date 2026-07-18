import { createHash } from "node:crypto";

export function createFileTreeSearchCursorScope(input: {
  knowledgeBaseId: string;
  generationId: string | null;
  query: string;
  limit: number;
}): string {
  return [
    "file-tree-search",
    input.knowledgeBaseId,
    input.generationId ?? "active",
    `query=${createFileTreeSearchSignature(input.query)}`,
    `limit=${input.limit}`
  ].join(":");
}

export function createFileTreeSearchSignature(query: string): string {
  return createHash("sha256")
    .update(query.trim().toLocaleLowerCase("en-US"))
    .digest("hex")
    .slice(0, 32);
}
