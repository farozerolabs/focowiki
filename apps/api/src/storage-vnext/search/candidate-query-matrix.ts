import type { StorageVnextSearchDocument } from "./documents.js";
import type {
  StorageVnextSearchValidationCase,
  StorageVnextSearchValidationKind
} from "./ports.js";

type SourceSample = {
  sourceFilePublicId: string;
  title: string | null;
  logicalPath: string;
};

type ContentSample = SourceSample & {
  hanTerms: readonly string[];
  latinTerms: readonly string[];
  anchoredHanTerm: string | null;
  anchoredLatinTerm: string | null;
  fallbackTerm: string | null;
  score: number;
};

type GraphSample = SourceSample & {
  query: string;
};

const CASE_LIMIT = 10;
const MAXIMUM_QUERY_BYTES = 4_096;
const MAXIMUM_CAPTURED_TERMS = 64;
const HAN_TERM_PATTERN = /\p{Script=Han}+(?:[-_]\p{Number}+)?/gu;
const LATIN_TERM_PATTERN = /[A-Za-z]+/gu;

export function createStorageVnextCandidateQueryMatrix() {
  let source: SourceSample | null = null;
  let titledSource: SourceSample | null = null;
  let content: ContentSample | null = null;
  let graph: GraphSample | null = null;

  return {
    observe(document: StorageVnextSearchDocument): void {
      const sample = sourceSample(document);
      source ??= sample;
      if (document.documentKind === "content") {
        if (document.title && !titledSource) titledSource = sample;
        if (document.contentKind !== "segment" || !document.searchText.trim()) return;
        const candidate = contentSample(document);
        if (!content || candidate.score > content.score) content = candidate;
        return;
      }
      if (!graph) graph = graphSample(document);
    },

    finish(): readonly StorageVnextSearchValidationCase[] {
      if (!source) return [];
      const title = titledSource ?? source;
      const contentSource = content ?? {
        ...source,
        hanTerms: [],
        latinTerms: [],
        anchoredHanTerm: null,
        anchoredLatinTerm: null,
        fallbackTerm: null,
        score: 0
      };
      const titleQuery = boundedQuery(title.title ?? "");
      const pathQuery = boundedQuery(title.logicalPath);
      const hanQuery = contentSource.anchoredHanTerm
        ?? preferredHanTerm(contentSource.hanTerms);
      const latinQuery = contentSource.anchoredLatinTerm
        ?? preferredLatinTerm(contentSource.latinTerms);
      const contentQuery = contentSource.anchoredHanTerm
        ?? contentSource.anchoredLatinTerm
        ?? hanQuery
        ?? latinQuery
        ?? contentSource.fallbackTerm;
      const multiTermQuery = preferredMultiTermQuery(contentSource);
      const phraseQuery = contentQuery ? boundedQuery(`"${contentQuery}"`) : null;
      const typoQuery = latinQuery ? createTypo(latinQuery) : null;
      const mixedScriptQuery = hanQuery && latinQuery
        ? boundedQuery(`${hanQuery} ${latinQuery}`)
        : null;
      const rankingQuery = titleQuery || contentQuery;
      const hasCapturedContentTerm = contentSource.hanTerms.length > 0
        || contentSource.latinTerms.length > 0;

      return [
        validationCase("exact", titleQuery, ["title"], "content", title, Boolean(titleQuery)),
        validationCase("title", titleQuery, ["title"], "content", title, Boolean(titleQuery)),
        validationCase("path", pathQuery, ["logicalPath"], "content", title, Boolean(pathQuery)),
        validationCase("content", contentQuery, ["searchText"], "content", contentSource, Boolean(contentQuery) && hasCapturedContentTerm),
        validationCase("multi_term", multiTermQuery, ["searchText"], "content", contentSource, Boolean(multiTermQuery)),
        validationCase("phrase", phraseQuery, ["searchText"], "content", contentSource, Boolean(phraseQuery) && hasCapturedContentTerm),
        validationCase("typo", typoQuery, ["searchText"], "content", contentSource, false),
        validationCase("chinese", hanQuery, ["searchText"], "content", contentSource, Boolean(hanQuery), "候选验证"),
        validationCase(
          "mixed_script",
          mixedScriptQuery,
          ["searchText"],
          "content",
          contentSource,
          Boolean(mixedScriptQuery),
          "候选 validation"
        ),
        validationCase(
          "graph_seed",
          graph?.query ?? null,
          ["searchText", "rankingTerms"],
          "graph_seed",
          graph ?? source,
          Boolean(graph?.query)
        ),
        validationCase(
          "ranking",
          rankingQuery,
          ["title", "searchText"],
          "content",
          title,
          Boolean(rankingQuery)
        )
      ];
    }
  };
}

function contentSample(
  document: Extract<StorageVnextSearchDocument, { documentKind: "content" }>
): ContentSample {
  const hanTerms = collectTerms(document.searchText, HAN_TERM_PATTERN, 2, 24);
  const latinTerms = collectTerms(document.searchText, LATIN_TERM_PATTERN, 3, 63);
  const anchoredHanTerm = anchoredTerm(
    document.title,
    document.searchText,
    HAN_TERM_PATTERN,
    2,
    24,
    false
  );
  const anchoredLatinTerm = anchoredTerm(
    document.title,
    document.searchText,
    LATIN_TERM_PATTERN,
    3,
    63,
    true
  );
  const fallbackTerm = firstFallbackTerm(document.searchText);
  return {
    ...sourceSample(document),
    hanTerms,
    latinTerms,
    anchoredHanTerm,
    anchoredLatinTerm,
    fallbackTerm,
    score: (hanTerms.some((term) => /\p{Number}/u.test(term)) ? 16 : 0)
      + (anchoredHanTerm || anchoredLatinTerm ? 8 : 0)
      + (hanTerms.length > 0 ? 4 : 0)
      + (latinTerms.some((term) => term.length >= 5) ? 4 : 0)
      + (hanTerms.length + latinTerms.length >= 2 ? 2 : 0)
  };
}

function graphSample(
  document: Extract<StorageVnextSearchDocument, { documentKind: "graph_seed" }>
): GraphSample {
  const query = document.rankingTerms.find(Boolean)
    ?? collectTerms(document.searchText, HAN_TERM_PATTERN, 2, 24)[0]
    ?? collectTerms(document.searchText, LATIN_TERM_PATTERN, 3, 63)[0]
    ?? firstFallbackTerm(document.searchText)
    ?? "";
  return { ...sourceSample(document), query: boundedQuery(query) };
}

function sourceSample(document: StorageVnextSearchDocument): SourceSample {
  return {
    sourceFilePublicId: document.sourceFilePublicId,
    title: document.title,
    logicalPath: document.logicalPath
  };
}

function validationCase(
  kind: StorageVnextSearchValidationKind,
  query: string | null,
  attributesToSearchOn: readonly string[],
  documentKind: "content" | "graph_seed",
  source: SourceSample,
  supported: boolean,
  fallbackQuery = "candidate validation"
): StorageVnextSearchValidationCase {
  return {
    kind,
    query: boundedQuery(query || fallbackQuery),
    attributesToSearchOn,
    documentKind,
    limit: CASE_LIMIT,
    relevantSources: [{ sourceFilePublicId: source.sourceFilePublicId, relevance: 3 }],
    minimumRecall: supported ? 1 : 0,
    minimumNdcg: supported ? 1 : 0
  };
}

function collectTerms(
  value: string,
  pattern: RegExp,
  minimumLength: number,
  maximumLength: number
): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const match of value.matchAll(pattern)) {
    const raw = match[0] ?? "";
    const length = [...raw].length;
    if (length < minimumLength || length > maximumLength) continue;
    const term = boundedQuery(raw);
    const normalized = term.toLocaleLowerCase("en");
    if (!term || seen.has(normalized)) continue;
    seen.add(normalized);
    terms.push(term);
    if (terms.length >= MAXIMUM_CAPTURED_TERMS) break;
  }
  return terms;
}

function preferredLatinTerm(terms: readonly string[]): string | null {
  return terms
    .filter((term) => term.length >= 5)
    .sort((left, right) => right.length - left.length)[0]
    ?? terms[0]
    ?? null;
}

function preferredHanTerm(terms: readonly string[]): string | null {
  return [...terms].sort((left, right) => right.length - left.length)[0] ?? null;
}

function anchoredTerm(
  title: string | null,
  searchText: string,
  pattern: RegExp,
  minimumLength: number,
  maximumLength: number,
  caseInsensitive: boolean
): string | null {
  const searchableTerms = new Set(collectTerms(
    searchText,
    pattern,
    minimumLength,
    maximumLength
  ).map((term) => caseInsensitive ? term.toLocaleLowerCase("en") : term));
  for (const term of collectTerms(
    title ?? "",
    pattern,
    minimumLength,
    maximumLength
  )) {
    const needle = caseInsensitive ? term.toLocaleLowerCase("en") : term;
    if (searchableTerms.has(needle)) return term;
  }
  return null;
}

function distinctQuery(values: readonly (string | null)[]): string | null {
  const terms = [...new Set(values.filter((value): value is string => Boolean(value)))];
  if (terms.length < 2) return null;
  return boundedQuery(`${terms[0]} ${terms[1]}`);
}

function preferredMultiTermQuery(sample: ContentSample): string | null {
  const distinctHan = preferredHanTerm(withoutTerm(
    sample.hanTerms,
    sample.anchoredHanTerm
  ));
  if (sample.anchoredHanTerm && distinctHan) {
    return distinctQuery([sample.anchoredHanTerm, distinctHan]);
  }
  const distinctLatin = preferredLatinTerm(withoutTerm(
    sample.latinTerms,
    sample.anchoredLatinTerm
  ));
  if (sample.anchoredLatinTerm && distinctLatin) {
    return distinctQuery([sample.anchoredLatinTerm, distinctLatin]);
  }
  return distinctQuery([
    sample.anchoredHanTerm,
    sample.anchoredLatinTerm,
    preferredHanTerm(sample.hanTerms),
    preferredLatinTerm(sample.latinTerms)
  ]);
}

function withoutTerm(terms: readonly string[], excluded: string | null) {
  if (!excluded) return terms;
  const normalized = excluded.toLocaleLowerCase("en");
  return terms.filter((term) => term.toLocaleLowerCase("en") !== normalized);
}

function createTypo(value: string): string {
  if (value.length < 5) return value;
  const middle = Math.floor(value.length / 2);
  return boundedQuery(value.slice(0, middle) + value.slice(middle + 1));
}

function firstFallbackTerm(value: string): string | null {
  for (const part of value.split(/\s+/u)) {
    const cleaned = part.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (cleaned.length >= 2) return boundedQuery(cleaned);
  }
  return null;
}

function boundedQuery(value: string): string {
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (Buffer.byteLength(normalized) <= MAXIMUM_QUERY_BYTES) return normalized;
  let end = normalized.length;
  while (end > 0 && Buffer.byteLength(normalized.slice(0, end)) > MAXIMUM_QUERY_BYTES) {
    end -= 1;
  }
  return normalized.slice(0, end).trim();
}
