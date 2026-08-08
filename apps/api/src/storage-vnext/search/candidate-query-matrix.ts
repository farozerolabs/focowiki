import type { StorageVnextSearchDocument } from "./documents.js";
import type { OkfSearchFilters, OkfSearchSignals } from "./okf-signals.js";
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

type SignalSample = SourceSample & {
  signals: OkfSearchSignals;
};

type TitleCandidate = {
  sample: SourceSample;
  sourceFilePublicIds: Set<string>;
  overflow: boolean;
};

type ValidationCaseOptions = {
  fallbackQuery?: string;
  limit?: number;
  supportedMinimumNdcg?: number;
  relevantSourceFilePublicIds?: readonly string[];
};

const CASE_LIMIT = 10;
const MAXIMUM_QUERY_BYTES = 4_096;
const MAXIMUM_CAPTURED_TERMS = 64;
const MAXIMUM_TITLE_CANDIDATES = 64;
const MAXIMUM_GRAPH_CANDIDATES = 64;
const MAXIMUM_VALIDATION_CASE_LIMIT = 100;
const HAN_TERM_PATTERN = /\p{Script=Han}+(?:[-_]\p{Number}+)?/gu;
const LATIN_TERM_PATTERN = /[A-Za-z]+/gu;

export function createStorageVnextCandidateQueryMatrix() {
  let source: SourceSample | null = null;
  const titleCandidates = new Map<string, TitleCandidate>();
  let content: ContentSample | null = null;
  let graphFallback: GraphSample | null = null;
  const graphCandidates = new Map<string, {
    sample: GraphSample;
    sourceFilePublicIds: Set<string>;
  }>();
  const signalSamples: SignalSample[] = [];

  return {
    observe(document: StorageVnextSearchDocument): void {
      const sample = sourceSample(document);
      source ??= sample;
      if (document.documentKind === "content") {
        observeTitleCandidate(titleCandidates, sample);
        if (
          document.contentKind === "file"
          && signalSamples.length < 16
          && !signalSamples.some((item) =>
            item.sourceFilePublicId === document.sourceFilePublicId)
        ) {
          signalSamples.push({ ...sample, signals: document.okfSignals });
        }
        if (document.contentKind !== "segment" || !document.searchText.trim()) return;
        const candidate = contentSample(document);
        if (!content || candidate.score > content.score) content = candidate;
        return;
      }
      const candidate = graphSample(document);
      graphFallback ??= candidate;
      observeGraphCandidates(graphCandidates, document.rankingTerms, candidate);
    },

    finish(): readonly StorageVnextSearchValidationCase[] {
      if (!source) return [];
      const titleCandidate = selectTitleCandidate(titleCandidates);
      const title = titleCandidate?.sample ?? source;
      const titleRelevantSourceFilePublicIds = titleCandidate
        ? [...titleCandidate.sourceFilePublicIds].sort()
        : [source.sourceFilePublicId];
      const titleCaseLimit = Math.max(
        CASE_LIMIT,
        titleRelevantSourceFilePublicIds.length
      );
      const contentSource = content ?? {
        ...source,
        hanTerms: [],
        latinTerms: [],
        anchoredHanTerm: null,
        anchoredLatinTerm: null,
        fallbackTerm: null,
        score: 0
      };
      const graph = selectSourceUniqueGraphTerm(graphCandidates);
      const selectedGraph = graph ?? graphFallback;
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
      const supportsTitleQuality = Boolean(titleQuery) && !titleCandidate?.overflow;
      const hasCapturedContentTerm = contentSource.hanTerms.length > 0
        || contentSource.latinTerms.length > 0;

      return [
        validationCase("exact", titleQuery, ["title"], "content", title, supportsTitleQuality, {
          limit: titleCaseLimit,
          relevantSourceFilePublicIds: titleRelevantSourceFilePublicIds
        }),
        validationCase("title", titleQuery, ["title"], "content", title, supportsTitleQuality, {
          limit: titleCaseLimit,
          relevantSourceFilePublicIds: titleRelevantSourceFilePublicIds
        }),
        validationCase("path", pathQuery, ["logicalPath"], "content", title, Boolean(pathQuery)),
        validationCase("content", contentQuery, ["searchText"], "content", contentSource, Boolean(contentQuery) && hasCapturedContentTerm),
        validationCase("multi_term", multiTermQuery, ["searchText"], "content", contentSource, Boolean(multiTermQuery)),
        validationCase("phrase", phraseQuery, ["searchText"], "content", contentSource, Boolean(phraseQuery) && hasCapturedContentTerm),
        validationCase("typo", typoQuery, ["searchText"], "content", contentSource, false),
        validationCase("chinese", hanQuery, ["searchText"], "content", contentSource, Boolean(hanQuery), {
          fallbackQuery: "候选验证"
        }),
        validationCase(
          "mixed_script",
          mixedScriptQuery,
          ["searchText"],
          "content",
          contentSource,
          Boolean(mixedScriptQuery),
          { fallbackQuery: "候选 validation" }
        ),
        validationCase(
          "graph_seed",
          selectedGraph?.query ?? null,
          ["searchText", "rankingTerms"],
          "graph_seed",
          selectedGraph ?? source,
          Boolean(graph?.query)
        ),
        validationCase(
          "ranking",
          rankingQuery,
          ["title", "searchText"],
          "content",
          title,
          Boolean(rankingQuery) && !titleCandidate?.overflow,
          {
            limit: titleCaseLimit,
            relevantSourceFilePublicIds: titleRelevantSourceFilePublicIds
          }
        ),
        ...okfValidationCases(signalSamples)
      ];
    }
  };
}

function observeTitleCandidate(
  candidates: Map<string, TitleCandidate>,
  sample: SourceSample
): void {
  const key = sample.title?.trim().toLocaleLowerCase("en") ?? "";
  if (!key) return;
  const existing = candidates.get(key);
  if (existing) {
    if (existing.sourceFilePublicIds.has(sample.sourceFilePublicId)) return;
    if (existing.sourceFilePublicIds.size >= MAXIMUM_VALIDATION_CASE_LIMIT) {
      existing.overflow = true;
      return;
    }
    existing.sourceFilePublicIds.add(sample.sourceFilePublicId);
    return;
  }
  if (candidates.size >= MAXIMUM_TITLE_CANDIDATES) return;
  candidates.set(key, {
    sample,
    sourceFilePublicIds: new Set([sample.sourceFilePublicId]),
    overflow: false
  });
}

function selectTitleCandidate(
  candidates: ReadonlyMap<string, TitleCandidate>
): TitleCandidate | null {
  let selected: TitleCandidate | null = null;
  for (const candidate of candidates.values()) {
    if (candidate.sourceFilePublicIds.size === 1) return candidate;
    if (
      !selected
      || selected.overflow && !candidate.overflow
      || selected.overflow === candidate.overflow
        && candidate.sourceFilePublicIds.size < selected.sourceFilePublicIds.size
    ) selected = candidate;
  }
  return selected;
}

function observeGraphCandidates(
  candidates: Map<string, {
    sample: GraphSample;
    sourceFilePublicIds: Set<string>;
  }>,
  terms: readonly string[],
  sample: GraphSample
): void {
  for (const query of [...terms, sample.query]) {
    const bounded = boundedQuery(query);
    const key = bounded.toLocaleLowerCase("en");
    if (!key) continue;
    const existing = candidates.get(key);
    if (existing) {
      existing.sourceFilePublicIds.add(sample.sourceFilePublicId);
      continue;
    }
    if (candidates.size >= MAXIMUM_GRAPH_CANDIDATES) continue;
    candidates.set(key, {
      sample: { ...sample, query: bounded },
      sourceFilePublicIds: new Set([sample.sourceFilePublicId])
    });
  }
}

function selectSourceUniqueGraphTerm(
  candidates: ReadonlyMap<string, {
    sample: GraphSample;
    sourceFilePublicIds: ReadonlySet<string>;
  }>
): GraphSample | null {
  for (const candidate of candidates.values()) {
    if (candidate.sourceFilePublicIds.size === 1) return candidate.sample;
  }
  return null;
}

function okfValidationCases(
  samples: readonly SignalSample[]
): StorageVnextSearchValidationCase[] {
  const cases: StorageVnextSearchValidationCase[] = [];
  const omitted = samples.find((sample) =>
    sample.signals.status === "stable"
    && sample.signals.trustTier === "unverified"
    && sample.signals.staleAfterEpochDay === null
  );
  if (omitted) cases.push(okfCase("okf_omitted", omitted, {
    status: "stable",
    trustTier: "unverified",
    freshness: null,
    requestEpochDay: null
  }));

  const malformed = samples.find((sample) =>
    sample.signals.status === null
    || sample.signals.trustTier === null
    || sample.signals.staleAfterEpochDay === null
  );
  if (malformed) {
    const filters: OkfSearchFilters = malformed.signals.status === null
      ? emptyFilters({ status: "stable" })
      : malformed.signals.trustTier === null
        ? emptyFilters({ trustTier: "unverified" })
        : emptyFilters({ freshness: "fresh", requestEpochDay: 0 });
    cases.push(okfCase("okf_malformed", malformed, filters, false));
  }

  const status = samples.find((sample) => sample.signals.status !== null);
  if (status) cases.push(okfCase("okf_status", status, emptyFilters({
    status: status.signals.status
  })));

  const trust = samples.find((sample) => sample.signals.trustTier !== null);
  if (trust) cases.push(okfCase("okf_trust", trust, emptyFilters({
    trustTier: trust.signals.trustTier
  })));

  const stale = samples.find((sample) => sample.signals.staleAfterEpochDay !== null);
  if (stale) {
    const boundary = stale.signals.staleAfterEpochDay!;
    cases.push(okfCase("okf_fresh", stale, emptyFilters({
      freshness: "fresh",
      requestEpochDay: boundary - 1
    })));
    cases.push(okfCase("okf_stale", stale, emptyFilters({
      freshness: "stale",
      requestEpochDay: boundary + 1
    })));
    cases.push(okfCase("okf_boundary", stale, emptyFilters({
      freshness: "stale",
      requestEpochDay: boundary
    })));
  }

  const combined = samples.find((sample) =>
    sample.signals.status !== null
    && sample.signals.trustTier !== null
    && sample.signals.staleAfterEpochDay !== null
  );
  if (combined) cases.push(okfCase("okf_combined", combined, {
    status: combined.signals.status,
    trustTier: combined.signals.trustTier,
    freshness: "stale",
    requestEpochDay: combined.signals.staleAfterEpochDay
  }));

  const unrelated = samples.find((sample) =>
    sample.signals.staleAfterEpochDay === null
    && sample.signals.status !== null
  );
  if (unrelated) cases.push(okfCase("okf_unrelated", unrelated, emptyFilters({
    status: unrelated.signals.status
  })));

  if (status) {
    const alternatives = ["draft", "stable", "deprecated"] as const;
    const different = alternatives.find((value) => value !== status.signals.status)!;
    cases.push(okfCase("okf_no_match", status, emptyFilters({
      status: different
    }), false));
  }
  return cases;
}

function okfCase(
  kind: Extract<StorageVnextSearchValidationKind, `okf_${string}`>,
  sample: SignalSample,
  okfFilters: OkfSearchFilters,
  matches = true
): StorageVnextSearchValidationCase {
  return {
    kind,
    query: boundedQuery(sample.logicalPath),
    attributesToSearchOn: ["logicalPath"],
    documentKind: "content",
    limit: CASE_LIMIT,
    relevantSources: matches
      ? [{ sourceFilePublicId: sample.sourceFilePublicId, relevance: 3 }]
      : [],
    minimumRecall: matches ? 1 : 0,
    minimumNdcg: matches ? 1 : 0,
    okfFilters
  };
}

function emptyFilters(
  values: Partial<OkfSearchFilters>
): OkfSearchFilters {
  return {
    status: null,
    trustTier: null,
    freshness: null,
    requestEpochDay: null,
    ...values
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
  options: ValidationCaseOptions = {}
): StorageVnextSearchValidationCase {
  const relevantSourceFilePublicIds = options.relevantSourceFilePublicIds
    ?? [source.sourceFilePublicId];
  return {
    kind,
    query: boundedQuery(query || options.fallbackQuery || "candidate validation"),
    attributesToSearchOn,
    documentKind,
    limit: options.limit ?? CASE_LIMIT,
    relevantSources: [...new Set(relevantSourceFilePublicIds)].map(
      (sourceFilePublicId) => ({ sourceFilePublicId, relevance: 3 })
    ),
    minimumRecall: supported ? 1 : 0,
    minimumNdcg: supported ? options.supportedMinimumNdcg ?? 1 : 0
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
