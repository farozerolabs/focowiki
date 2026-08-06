import type { OkfGraphNode } from "@focowiki/okf";
import type { LexicalTokenizer } from "../application/ports/lexical-tokenizer.js";
import { isUsefulTerm } from "./content-profile.js";
import {
  extractPathTerms,
  extractSearchTerms,
  readContentProfileStringArray,
  unique
} from "./graph-utils.js";

export function buildCandidateTerms(
  node: OkfGraphNode,
  tokenizer: LexicalTokenizer
): string[] {
  return collectCandidateTerms(node, [
    ...extractSearchTerms(node.title, tokenizer),
    ...extractPathTerms(node.path, tokenizer)
  ]);
}

export function buildPersistedGraphCandidateTerms(node: OkfGraphNode): string[] {
  const pathTerms = node.path
    .normalize("NFKC")
    .split(/[\s/_.-]+/u)
    .map((term) => term.trim())
    .filter(Boolean);
  return collectCandidateTerms(node, [node.title, ...pathTerms]);
}

function collectCandidateTerms(
  node: OkfGraphNode,
  identityTerms: readonly string[]
): string[] {
  const definitions = readContentProfileStringArray(node, "definitions");
  const processHints = readContentProfileStringArray(node, "processHints");
  const versionHints = readContentProfileStringArray(node, "versionHints");
  const evidencePhrases = readContentProfileStringArray(node, "evidencePhrases");

  return unique([
    ...identityTerms,
    ...(node.subjects ?? []),
    ...(node.entities ?? []),
    ...(node.keywords ?? []),
    ...(node.explicitReferences ?? []),
    ...(node.relationshipHints ?? []),
    ...definitions,
    ...processHints,
    ...versionHints,
    ...evidencePhrases,
    ...(node.tags ?? [])
  ])
    .filter(isUsefulTerm)
    .slice(0, 100);
}
