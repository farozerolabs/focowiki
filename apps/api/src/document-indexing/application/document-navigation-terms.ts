import { createHash } from "node:crypto";
import type { LexicalTokenizer } from "../../application/ports/lexical-tokenizer.js";

export const DOCUMENT_NAVIGATION_TERM_DEFAULT_LIMIT = 128;
export const DOCUMENT_NAVIGATION_TERM_ABSOLUTE_LIMIT = 256;
const DOCUMENT_NAVIGATION_TERM_CONTRACT = "document-navigation-terms-v1";
const BODY_CHARACTER_LIMIT = 65_536;

export type DocumentNavigationTermField =
  | "title"
  | "alias"
  | "path"
  | "heading"
  | "metadata"
  | "entity"
  | "model_keyword"
  | "body";

export type DocumentNavigationTerm = Readonly<{
  term: string;
  fields: readonly DocumentNavigationTermField[];
}>;

export type DocumentNavigationTermInput = Readonly<{
  path: string;
  title: string;
  aliases: readonly string[];
  headings: readonly string[];
  metadata: readonly string[];
  entities: readonly string[];
  modelKeywords: readonly string[];
  body: string;
}>;

type Candidate = {
  term: string;
  fields: Set<DocumentNavigationTermField>;
  score: number;
};

const FIELD_SCORES: Readonly<Record<DocumentNavigationTermField, number>> = {
  title: 800,
  alias: 720,
  path: 760,
  heading: 640,
  metadata: 560,
  entity: 520,
  model_keyword: 480,
  body: 100
};
const FIELD_ORDER = Object.keys(FIELD_SCORES) as DocumentNavigationTermField[];

export function selectDocumentNavigationTerms(
  input: DocumentNavigationTermInput,
  tokenizer: LexicalTokenizer,
  options: Readonly<{ maximumTerms?: number }> = {}
): Readonly<{
  fingerprint: string;
  terms: readonly DocumentNavigationTerm[];
}> {
  const maximumTerms = options.maximumTerms
    ?? DOCUMENT_NAVIGATION_TERM_DEFAULT_LIMIT;
  assertMaximumTerms(maximumTerms);
  const candidates = new Map<string, Candidate>();
  collect(candidates, tokenizer, "title", [input.title], 64);
  collect(candidates, tokenizer, "path", [input.path.replaceAll("/", " ")], 64);
  collect(candidates, tokenizer, "alias", input.aliases, 64);
  collect(candidates, tokenizer, "heading", input.headings, 64);
  collect(candidates, tokenizer, "metadata", input.metadata, 64);
  collect(candidates, tokenizer, "entity", input.entities, 64);
  collect(candidates, tokenizer, "model_keyword", input.modelKeywords, 64);
  collect(candidates, tokenizer, "body", [input.body.slice(0, BODY_CHARACTER_LIMIT)], 256);
  const terms = [...candidates.values()]
    .sort((left, right) => right.score - left.score
      || compareText(left.term, right.term))
    .slice(0, maximumTerms)
    .map((candidate) => ({
      term: candidate.term,
      fields: FIELD_ORDER.filter((field) => candidate.fields.has(field))
    }));
  return {
    fingerprint: documentNavigationTermFingerprint(tokenizer, maximumTerms),
    terms
  };
}

export function documentNavigationTermFingerprint(
  tokenizer: Pick<LexicalTokenizer, "contractVersion">,
  maximumTerms: number = DOCUMENT_NAVIGATION_TERM_DEFAULT_LIMIT
): string {
  assertMaximumTerms(maximumTerms);
  return createHash("sha256").update(JSON.stringify({
    selectionContract: DOCUMENT_NAVIGATION_TERM_CONTRACT,
    tokenizerContract: tokenizer.contractVersion,
    maximumTerms
  })).digest("hex");
}

function collect(
  candidates: Map<string, Candidate>,
  tokenizer: LexicalTokenizer,
  field: DocumentNavigationTermField,
  values: readonly string[],
  perValueLimit: number
): void {
  for (const value of values.slice(0, DOCUMENT_NAVIGATION_TERM_ABSOLUTE_LIMIT)) {
    if (!value.trim()) continue;
    for (const term of tokenizer.tokenizeDocument(value, perValueLimit)) {
      const existing = candidates.get(term);
      if (existing) {
        existing.fields.add(field);
        existing.score += FIELD_SCORES[field];
      } else {
        candidates.set(term, {
          term,
          fields: new Set([field]),
          score: FIELD_SCORES[field]
        });
      }
    }
  }
}

function assertMaximumTerms(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1
    || value > DOCUMENT_NAVIGATION_TERM_ABSOLUTE_LIMIT) {
    throw new Error("document_navigation_term_limit_invalid");
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
