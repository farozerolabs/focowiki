import { createHash } from "node:crypto";
import type { LexicalTokenizer } from "../application/ports/lexical-tokenizer.js";
import { tokenizeBoundedDocument } from "../application/bounded-tokenization.js";

const EXACT_TERM_LIMIT = 600;
const PHRASE_TERM_LIMIT = 120;
const REFERENCE_LIMIT = 100;
const LEXICAL_TEXT_MAX_BYTES = 64 * 1024;
const SIGNAL_TERM_LIMIT = 64;
const QUERY_EXACT_TERM_LIMIT = 100;
const QUERY_PHRASE_TERM_LIMIT = 32;

export type GraphTermDocument = {
  sourceFileId: string;
  sourceRevisionId: string;
  fingerprint: string;
  lexicalText: string;
  exactTerms: string[];
  phraseTerms: string[];
  explicitReferences: string[];
  tokenizerContractVersion: string;
  lexicalProjectionVersion: string;
};

export type GraphQueryTerms = {
  exactTerms: string[];
  phraseTerms: string[];
  explicitReferences: string[];
  lexicalText: string;
};

export const GRAPH_LEXICAL_PROJECTION_VERSION = "graph-lexical-v2";

export function buildGraphTermDocument(input: {
  sourceFileId: string;
  sourceRevisionId: string;
  title: string;
  body: string;
  headings: string[];
  phrases: string[];
  entities: string[];
  explicitReferences: string[];
  supplementalTerms: string[];
  tokenizer: LexicalTokenizer;
}): GraphTermDocument {
  const bodyText = normalizeText(stripMarkdown(input.body));
  const title = normalizeText(input.title);
  const exactTerms = collectExactTerms({ ...input, title, bodyText });
  const phraseTerms = collectNormalized(
    [input.headings, input.phrases, input.entities],
    normalizePhrase,
    isUsefulPhrase,
    PHRASE_TERM_LIMIT
  );
  const explicitReferences = collectNormalized(
    [input.explicitReferences],
    normalizeReference,
    Boolean,
    REFERENCE_LIMIT
  );
  const lexicalText = truncateUtf8(
    unique([title, ...exactTerms, ...phraseTerms]).join(" "),
    LEXICAL_TEXT_MAX_BYTES
  );
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({
      sourceRevisionId: input.sourceRevisionId,
      lexicalText,
      exactTerms,
      phraseTerms,
      explicitReferences,
      tokenizerContractVersion: input.tokenizer.contractVersion,
      lexicalProjectionVersion: GRAPH_LEXICAL_PROJECTION_VERSION
    }))
    .digest("hex");

  return {
    sourceFileId: input.sourceFileId,
    sourceRevisionId: input.sourceRevisionId,
    fingerprint,
    lexicalText,
    exactTerms,
    phraseTerms,
    explicitReferences,
    tokenizerContractVersion: input.tokenizer.contractVersion,
    lexicalProjectionVersion: GRAPH_LEXICAL_PROJECTION_VERSION
  };
}

export function buildGraphQueryTerms(
  values: string[],
  tokenizer: LexicalTokenizer
): GraphQueryTerms {
  const normalized = collectNormalized(
    [values],
    normalizePhrase,
    isUsefulPhrase,
    PHRASE_TERM_LIMIT
  );
  const exactTerms = collectSignals(normalized, QUERY_EXACT_TERM_LIMIT, tokenizer);
  const phraseTerms = normalized.filter(isQueryPhrase).slice(0, QUERY_PHRASE_TERM_LIMIT);
  const explicitReferences = collectNormalized(
    [values],
    normalizeReference,
    isExplicitReference,
    REFERENCE_LIMIT
  );

  return {
    exactTerms,
    phraseTerms,
    explicitReferences,
    lexicalText: truncateUtf8(unique([...exactTerms, ...phraseTerms]).join(" "), 4 * 1024)
  };
}

function collectExactTerms(input: {
  title: string;
  bodyText: string;
  headings: string[];
  phrases: string[];
  entities: string[];
  supplementalTerms: string[];
  tokenizer: LexicalTokenizer;
}): string[] {
  const terms = new Set<string>();
  appendTerms(
    terms,
    input.tokenizer.tokenizeDocument(input.title, EXACT_TERM_LIMIT),
    EXACT_TERM_LIMIT
  );
  appendTerms(
    terms,
    collectSignals(input.headings, SIGNAL_TERM_LIMIT, input.tokenizer),
    EXACT_TERM_LIMIT
  );
  appendTerms(
    terms,
    collectSignals(input.phrases, SIGNAL_TERM_LIMIT, input.tokenizer),
    EXACT_TERM_LIMIT
  );
  appendTerms(
    terms,
    collectSignals(input.entities, SIGNAL_TERM_LIMIT, input.tokenizer),
    EXACT_TERM_LIMIT
  );
  appendTerms(
    terms,
    tokenizeBoundedDocument(input.tokenizer, input.bodyText, EXACT_TERM_LIMIT),
    EXACT_TERM_LIMIT
  );
  appendTerms(
    terms,
    collectSignals(input.supplementalTerms, SIGNAL_TERM_LIMIT, input.tokenizer),
    EXACT_TERM_LIMIT
  );
  return Array.from(terms);
}

function collectSignals(
  values: string[],
  limit: number,
  tokenizer: LexicalTokenizer
): string[] {
  const terms = new Set<string>();
  for (const value of values) {
    appendTerms(terms, tokenizer.tokenizeDocument(value, limit), limit);
    if (terms.size >= limit) break;
  }
  return Array.from(terms);
}

function stripMarkdown(value: string): string {
  return value
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/`([^`]*)`/gu, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/<https?:\/\/[^>]+>/gu, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gmu, "")
    .replace(/[>*_~|]/gu, " ");
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizePhrase(value: string): string {
  return normalizeText(value).replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, "");
}

function normalizeReference(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/^\.\//u, "")
    .replace(/^\/+|#.*$/gu, "");
}

function isUsefulPhrase(value: string): boolean {
  return value.length >= 2 && value.length <= 200;
}

function isQueryPhrase(value: string): boolean {
  return isUsefulPhrase(value) && (
    /\s/u.test(value)
    || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{3,}/u.test(value)
  );
}

function isExplicitReference(value: string): boolean {
  return isUsefulPhrase(value) && (
    value.includes("/")
    || /\.(?:md|markdown)$/iu.test(value)
  );
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function appendTerms(target: Set<string>, values: Iterable<string>, limit: number): void {
  if (target.size >= limit) return;
  for (const value of values) {
    if (value) target.add(value);
    if (target.size >= limit) return;
  }
}

function collectNormalized(
  groups: string[][],
  normalize: (value: string) => string,
  accept: (value: string) => boolean,
  limit: number
): string[] {
  const values = new Set<string>();
  for (const group of groups) {
    for (const value of group) {
      const normalized = normalize(value);
      if (accept(normalized)) values.add(normalized);
      if (values.size >= limit) return Array.from(values);
    }
  }
  return Array.from(values);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end)) > maxBytes) end -= 1;
  return value.slice(0, end).trimEnd();
}
