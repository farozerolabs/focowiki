import { canonicalizeOptionalGeneratedTextIdentity } from "./text-identity.js";

export function knowledgeBaseTitle(title: string | undefined): string {
  return canonicalizeOptionalGeneratedTextIdentity(title, "knowledge base title")
    ?? "Knowledge base";
}
