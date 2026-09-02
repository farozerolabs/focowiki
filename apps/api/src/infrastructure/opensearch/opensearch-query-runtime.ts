import { createHash } from "node:crypto";
import type { LexicalTokenizer } from
  "../../application/ports/lexical-tokenizer.js";
import type {
  SearchFilterExpression,
  SearchProviderHit,
  SearchProviderQueryPort,
  SearchProviderQueryRequest
} from "../../application/ports/search-provider-runtime.js";
import { SearchProviderError } from
  "../../application/ports/search-provider-runtime.js";
import type { OpenSearchClientPort } from "./opensearch-client-port.js";
import { normalizeOpenSearchError } from "./opensearch-errors.js";
import { createSearchTermPlan } from
  "../../application/search/query-term-policy.js";

const MAXIMUM_QUERY_BYTES = 4_096;
const MAXIMUM_PAGE_SIZE = 1_000;
const CURSOR_VERSION = 1;
const EVIDENCE_FAMILIES = new Set([
  "exact", "text", "phrase", "typo", "jieba", "graph"
]);
const SEARCH_FIELDS = new Set([
  "title", "logicalPath", "targetTitle", "targetLogicalPath",
  "headingAncestors", "searchText", "rankingTerms"
]);
const RETURN_FIELDS = new Set([
  "id", "schemaVersion", "documentKind", "contentKind", "knowledgeBaseId",
  "sourceFilePublicId", "sourceRevisionPublicId", "logicalPath", "fileKind",
  "title", "segmentOrdinal", "headingAncestors", "searchText", "rankingTerms",
  "okfSignals", "targetSourceFilePublicId", "targetSourceRevisionPublicId"
]);
const REQUIRED_RETURN_FIELDS = [
  "id", "documentKind", "sourceFilePublicId", "sourceRevisionPublicId",
  "logicalPath", "title"
];
const FIELD_BOOSTS: Readonly<Record<string, number>> = {
  title: 6,
  logicalPath: 5,
  headingAncestors: 3,
  searchText: 1,
  rankingTerms: 2
};

type QuerySort = readonly [number, string, string];
type QueryContinuation = {
  offset: number;
  sort: QuerySort;
};

export function createOpenSearchQueryPort(input: {
  client: Pick<OpenSearchClientPort, "search">;
  tokenizer: LexicalTokenizer;
  maximumResultWindow: number;
  engineSearchCutoffMs: number;
}): SearchProviderQueryPort {
  if (
    !input.tokenizer.contractVersion
    || !Number.isSafeInteger(input.maximumResultWindow)
    || input.maximumResultWindow < 1 || input.maximumResultWindow > 100_000
    || !Number.isSafeInteger(input.engineSearchCutoffMs)
    || input.engineSearchCutoffMs < 50 || input.engineSearchCutoffMs > 10_000
  ) throw requestError();
  return {
    async query(request) {
      const normalized = normalizeRequest(request);
      const scopeHash = createScopeHash(normalized, input.tokenizer.contractVersion);
      const continuation = decodeContinuation(normalized.continuation, scopeHash);
      const offset = normalized.distinctBy ? continuation?.offset ?? 0 : 0;
      const remaining = input.maximumResultWindow - offset;
      if (remaining <= 0) {
        return { hits: [], continuation: null, processingTimeMs: 0 };
      }
      const requestSize = Math.min(normalized.limit + 1, remaining);
      const should = buildEvidenceClauses(normalized, input.tokenizer);
      if (should.length === 0) throw requestError();
      const highlight = createHighlight(normalized);
      const engineTimeoutMs = Math.min(
        normalized.deadlineMs,
        input.engineSearchCutoffMs
      );
      const response = await execute(() => input.client.search({
        index: normalized.indexUid,
        body: {
          _source: resultFields(normalized.returnFields),
          query: {
            bool: {
              filter: [renderFilter(normalized.filters)],
              should,
              minimum_should_match: 1
            }
          },
          size: requestSize,
          timeout: `${engineTimeoutMs}ms`,
          track_scores: true,
          sort: [
            { _score: "desc" },
            { sourceFilePublicId: "asc" },
            { id: "asc" }
          ],
          ...(normalized.distinctBy
            ? { from: offset }
            : continuation ? { search_after: [...continuation.sort] } : {}),
          ...(highlight ? { highlight } : {}),
          ...(normalized.distinctBy ? {
            collapse: {
              field: normalized.distinctBy,
              inner_hits: {
                name: "best_segment",
                size: 1,
                sort: [{ _score: "desc" }, { id: "asc" }],
                ...(highlight ? { highlight } : {})
              }
            }
          } : {})
        }
      }, { requestTimeout: normalized.deadlineMs }));
      return parseResult(
        response.body,
        normalized.limit,
        requestSize,
        offset,
        normalized.cropLength,
        scopeHash
      );
    }
  };
}

function buildEvidenceClauses(
  request: ReturnType<typeof normalizeRequest>,
  tokenizer: LexicalTokenizer
): Record<string, unknown>[] {
  const families = new Set(request.evidenceFamilies);
  const fields = weightedFields(request.searchFields);
  const clauses: Record<string, unknown>[] = [];
  const needsLexicalQuery = ([
    "text", "phrase", "typo", "jieba", "graph"
  ] as const)
    .some((family) => families.has(family));
  let execution = {
    executionQuery: "",
    informativeTerms: [] as readonly string[],
    minimumShouldMatch: 0
  };
  if (needsLexicalQuery) {
    try {
      execution = createSearchTermPlan({
        query: request.query,
        tokenizer,
        relaxed: request.relaxedTermCoverage === true
      });
    } catch {
      throw requestError();
    }
  }
  if (families.has("exact")) {
    const exact = normalizeExact(request.query);
    if (request.searchFields.includes("title")) {
      clauses.push({ term: { _focowikiTitleExact: { value: exact, boost: 12 } } });
    }
    if (request.searchFields.includes("logicalPath")) {
      clauses.push({ term: { _focowikiPathExact: { value: exact, boost: 10 } } });
    }
  }
  if (families.has("text") && fields.length > 0) {
    clauses.push({
      multi_match: {
        query: execution.executionQuery,
        fields,
        type: "best_fields",
        operator: "or",
        minimum_should_match: execution.minimumShouldMatch,
        tie_breaker: 0.2,
        boost: 4
      }
    });
  }
  if (families.has("phrase") && fields.length > 0) {
    clauses.push({
      multi_match: {
        query: execution.executionQuery,
        fields,
        type: "phrase",
        slop: 1,
        boost: 6
      }
    });
  }
  if (
    families.has("typo")
    && isEligibleForFuzzyEvidence(request.query, execution.informativeTerms)
  ) {
    clauses.push({
      multi_match: {
        query: execution.executionQuery,
        fields,
        type: "best_fields",
        fuzziness: "AUTO",
        prefix_length: 1,
        max_expansions: 10,
        boost: 0.8
      }
    });
  }
  if (families.has("jieba")) {
    if (execution.informativeTerms.length > 0) {
      clauses.push({
        match: {
          _focowikiJiebaText: {
            query: execution.executionQuery,
            operator: "or",
            minimum_should_match: execution.minimumShouldMatch,
            boost: 5
          }
        }
      });
    }
  }
  if (families.has("graph")) {
    const graphFields = weightedFields(
      request.searchFields.filter((field) =>
        field === "rankingTerms" || field === "searchText" || field === "title"
      )
    );
    if (graphFields.length > 0) {
      clauses.push({
        multi_match: {
          query: execution.executionQuery,
          fields: graphFields,
          type: "most_fields",
          operator: "or",
          minimum_should_match: execution.minimumShouldMatch,
          boost: 3
        }
      });
    }
  }
  if (
    request.matchingStrategy === "last"
    && /\p{Script=Han}/u.test(request.query)
    && needsLexicalQuery
    && clauses.length > 0
  ) {
    return [{
      bool: {
        must: [{
          match: {
            _focowikiJiebaText: {
              query: execution.executionQuery,
              operator: "or",
              minimum_should_match: execution.minimumShouldMatch
            }
          }
        }],
        should: clauses,
        minimum_should_match: 1
      }
    }];
  }
  return clauses;
}

function parseResult(
  value: unknown,
  limit: number,
  requestSize: number,
  offset: number,
  cropLength: number,
  scopeHash: string
) {
  const body = objectValue(value);
  const rawHits = objectValue(body?.hits)?.hits;
  const took = body?.took;
  if (
    !Array.isArray(rawHits)
    || !Number.isFinite(took) || Number(took) < 0
    || rawHits.length > requestSize
  ) throw requestError();
  const parsed = rawHits.map((hit, index) => parseHit(
    hit,
    cropLength,
    scopeHash,
    offset + index + 1
  ));
  const uniqueSources = new Set(parsed.map((hit) => hit.sourceFilePublicId));
  if (uniqueSources.size !== parsed.length) throw requestError();
  const selected = parsed.slice(0, limit);
  return {
    hits: selected,
    continuation: parsed.length > limit
      ? selected.at(-1)?.continuationAfter ?? null
      : null,
    processingTimeMs: Number(took)
  };
}

function parseHit(
  value: unknown,
  cropLength: number,
  scopeHash: string,
  nextOffset: number
): SearchProviderHit {
  const hit = objectValue(value);
  const source = objectValue(hit?._source);
  const score = hit?._score;
  const sort = parseSort(hit?.sort);
  if (
    !hit || !source
    || typeof hit._id !== "string" || !hit._id
    || source.id !== hit._id
    || typeof source.sourceFilePublicId !== "string" || !source.sourceFilePublicId
    || typeof source.sourceRevisionPublicId !== "string"
      || !source.sourceRevisionPublicId
    || typeof source.logicalPath !== "string" || !source.logicalPath
    || source.sourceFilePublicId !== sort[1] || hit._id !== sort[2]
    || typeof score !== "number" || !Number.isFinite(score) || score < 0
  ) throw requestError();
  return {
    documentId: hit._id,
    sourceFilePublicId: source.sourceFilePublicId,
    sourceRevisionPublicId: source.sourceRevisionPublicId,
    logicalPath: source.logicalPath,
    title: typeof source.title === "string" ? source.title : "",
    normalizedScore: score / (1 + score),
    snippets: readSnippets(hit, cropLength),
    matchedFields: readMatchedFields(hit),
    sortKey: [...sort],
    continuationAfter: encodeContinuation(scopeHash, {
      offset: nextOffset,
      sort
    }),
    document: source
  };
}

function readMatchedFields(hit: Record<string, unknown>): string[] {
  const topLevel = highlightFields(hit.highlight);
  const innerHits = objectValue(hit.inner_hits);
  const bestSegment = objectValue(innerHits?.best_segment);
  const nested = objectValue(bestSegment?.hits)?.hits;
  const nestedFields = Array.isArray(nested) && nested.length > 0
    ? highlightFields(objectValue(nested[0])?.highlight)
    : [];
  return [...new Set([...topLevel, ...nestedFields])].sort((left, right) =>
    left.localeCompare(right, "en"));
}

function highlightFields(value: unknown): string[] {
  const highlight = objectValue(value);
  if (!highlight) return [];
  return Object.entries(highlight)
    .filter(([, fragments]) => Array.isArray(fragments) && fragments.length > 0)
    .map(([field]) => field.replace(/^segments\./u, ""));
}

function readSnippets(
  hit: Record<string, unknown>,
  cropLength: number
): string[] {
  if (cropLength === 0) return [];
  const topLevel = snippetsFromHighlight(hit.highlight);
  if (topLevel.length > 0) return boundSnippets(topLevel, cropLength);
  const innerHits = objectValue(hit.inner_hits);
  const bestSegment = objectValue(innerHits?.best_segment);
  const nested = objectValue(bestSegment?.hits)?.hits;
  if (!Array.isArray(nested) || nested.length === 0) return [];
  return boundSnippets(
    snippetsFromHighlight(objectValue(nested[0])?.highlight),
    cropLength
  );
}

function snippetsFromHighlight(value: unknown): string[] {
  const highlight = objectValue(value);
  if (!highlight) return [];
  const priority = [
    "searchText", "title", "logicalPath", "headingAncestors", "rankingTerms"
  ];
  return priority.flatMap((field) => {
    const fragments = highlight[field];
    return Array.isArray(fragments)
      ? fragments.filter((fragment): fragment is string =>
          typeof fragment === "string" && fragment.length > 0
        )
      : [];
  });
}

function boundSnippets(values: readonly string[], cropLength: number): string[] {
  const maximumCharacters = Math.max(100, cropLength * 10);
  return values.slice(0, 3).map((value) =>
    value.length <= maximumCharacters ? value : value.slice(0, maximumCharacters)
  );
}

function createHighlight(request: ReturnType<typeof normalizeRequest>) {
  if (request.cropLength === 0) return null;
  return {
    fields: Object.fromEntries(request.searchFields.map((field) => [field, {
      fragment_size: request.cropLength,
      number_of_fragments: 1,
      no_match_size: 0
    }])),
    pre_tags: ["<em>"],
    post_tags: ["</em>"]
  };
}

function resultFields(fields: readonly string[]): string[] {
  return [...new Set([...REQUIRED_RETURN_FIELDS, ...fields])];
}

function renderFilter(filter: SearchFilterExpression): Record<string, unknown> {
  if (filter.kind === "equals" || filter.kind === "boolean") {
    return { term: { [filter.field]: filter.value } };
  }
  if (filter.kind === "range") {
    if (!Number.isSafeInteger(filter.value)) throw requestError();
    return { range: { [filter.field]: { [filter.operator]: filter.value } } };
  }
  if (filter.operands.length === 0 || filter.operands.length > 100) {
    throw requestError();
  }
  const rendered = filter.operands.map(renderFilter);
  return filter.kind === "and"
    ? { bool: { filter: rendered } }
    : { bool: { should: rendered, minimum_should_match: 1 } };
}

function normalizeRequest(request: SearchProviderQueryRequest) {
  const query = request.query.trim().replace(/\s+/gu, " ");
  const evidenceFamilies = [...new Set(request.evidenceFamilies)];
  const searchFields = [...new Set(request.searchFields)];
  const returnFields = [...new Set(request.returnFields)];
  if (
    !/^[A-Za-z0-9_-]{1,255}$/u.test(request.indexUid)
    || !query || Buffer.byteLength(query, "utf8") > MAXIMUM_QUERY_BYTES
    || evidenceFamilies.length === 0
    || evidenceFamilies.some((family) => !EVIDENCE_FAMILIES.has(family))
    || searchFields.length === 0
    || searchFields.some((field) => !SEARCH_FIELDS.has(field))
    || returnFields.some((field) => !RETURN_FIELDS.has(field))
    || !Number.isSafeInteger(request.limit)
    || request.limit < 1 || request.limit > MAXIMUM_PAGE_SIZE
    || !Number.isSafeInteger(request.cropLength)
    || request.cropLength < 0 || request.cropLength > 5_000
    || !Number.isSafeInteger(request.deadlineMs)
    || request.deadlineMs < 100 || request.deadlineMs > 120_000
    || !["all", "last"].includes(request.matchingStrategy)
    || request.distinctBy !== null
      && request.distinctBy !== "sourceFilePublicId"
  ) throw requestError();
  return {
    ...request,
    query,
    evidenceFamilies,
    searchFields,
    returnFields
  };
}

function weightedFields(fields: readonly string[]): string[] {
  return fields.map((field) => `${field}^${FIELD_BOOSTS[field] ?? 1}`);
}

function isEligibleForFuzzyEvidence(query: string, terms: readonly string[]) {
  return terms.length <= 4
    && /(?:^|\s)[A-Za-z][A-Za-z0-9-]{3,}(?:\s|$)/u.test(query)
    && terms.some((term) => /^[A-Za-z][A-Za-z0-9-]{3,}$/u.test(term));
}

function normalizeExact(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function createScopeHash(
  request: ReturnType<typeof normalizeRequest>,
  tokenizerContractVersion: string
) {
  const { continuation: _continuation, ...scope } = request;
  return createHash("sha256")
    .update(JSON.stringify({ ...scope, tokenizerContractVersion }))
    .digest("hex");
}

function encodeContinuation(scopeHash: string, after: QueryContinuation) {
  return Buffer.from(JSON.stringify({
    v: CURSOR_VERSION,
    provider: "opensearch",
    scopeHash,
    after
  }), "utf8").toString("base64url");
}

function decodeContinuation(
  value: string | null,
  scopeHash: string
): QueryContinuation | null {
  if (value === null) return null;
  if (!value || value.length > 8_192) throw requestError();
  try {
    const record = objectValue(JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    ));
    if (
      record?.v !== CURSOR_VERSION
      || record.provider !== "opensearch"
      || record.scopeHash !== scopeHash
      || Object.keys(record).length !== 4
    ) throw requestError();
    const after = objectValue(record.after);
    if (
      !after
      || !Number.isSafeInteger(after.offset) || Number(after.offset) < 1
      || Object.keys(after).length !== 2
    ) throw requestError();
    return { offset: Number(after.offset), sort: parseSort(after.sort) };
  } catch (error) {
    if (error instanceof SearchProviderError) throw error;
    throw requestError();
  }
}

function parseSort(value: unknown): QuerySort {
  if (
    !Array.isArray(value) || value.length !== 3
    || typeof value[0] !== "number" || !Number.isFinite(value[0])
    || typeof value[1] !== "string" || !value[1]
    || typeof value[2] !== "string" || !value[2]
  ) throw requestError();
  return [value[0], value[1], value[2]];
}

async function execute<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw normalizeOpenSearchError(error);
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requestError() {
  return new SearchProviderError("SEARCH_ENGINE_REQUEST_FAILED", false);
}
