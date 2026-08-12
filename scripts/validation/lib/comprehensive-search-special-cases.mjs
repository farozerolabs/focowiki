import { createHash } from "node:crypto";

import {
  evaluateComprehensiveReturnedItems,
  evaluateExpectedRerankerOutcome
} from "./comprehensive-search-ledger.mjs";

export const COMPREHENSIVE_SEARCH_SPECIAL_CATEGORIES = Object.freeze([
  "duplicate_title",
  "similar_file",
  "nested_path",
  "multilingual",
  "cjk_jieba",
  "sparse_or_malformed_metadata",
  "filter",
  "pagination",
  "cursor",
  "no_result",
  "entity",
  "relationship",
  "multi_hop",
  "community_theme",
  "threshold",
  "cross_knowledge_base"
]);

const SPECIAL_CATEGORY_SET = new Set(COMPREHENSIVE_SEARCH_SPECIAL_CATEGORIES);
const SIMILAR_TITLE_MINIMUM_BIGRAM_JACCARD = 0.6;
const SEARCH_EVIDENCE_FAMILIES = new Set([
  "exact_path", "exact_title", "lexical", "jieba", "file_graph",
  "content_vector", "entity_vector", "relationship_vector", "community_vector"
]);
const SEMANTIC_SAFE_CODES = new Set([
  "SEMANTIC_ADOPTION_REQUIRED",
  "SEMANTIC_LEXICAL_PROJECTION_UNAVAILABLE",
  "SEMANTIC_PROVIDER_ADOPTION_REQUIRED",
  "SEMANTIC_SEARCH_UNAVAILABLE",
  "SEMANTIC_LANE_PARTIAL_FAILURE"
]);

export function buildComprehensiveSearchSpecialCasePlan(input) {
  const report = requireProviderReport(input?.providerReport);
  const manifestRows = requireArray(input?.manifestRows, "manifest rows");
  const manifestByAlias = new Map(manifestRows.map((row) => [
    requireString(row?.alias, "manifest alias"),
    row
  ]));
  if (manifestByAlias.size !== manifestRows.length) {
    throw new Error("Comprehensive search special-case manifest has duplicate aliases");
  }
  const rows = [...report.rows].sort(compareAlias);
  for (const row of rows) {
    if (!manifestByAlias.has(row.alias)) {
      throw new Error(`Comprehensive search special-case manifest is missing ${row.alias}`);
    }
    validateProviderRow(row);
  }
  if (manifestByAlias.size !== rows.length) {
    throw new Error("Comprehensive search special-case manifest has unmatched rows");
  }

  const cases = [];
  const rowByAlias = new Map(rows.map((row) => [row.alias, row]));
  const knowledgeBaseRows = Map.groupBy(rows, (row) => row.knowledgeBaseId);
  const titleGroups = Map.groupBy(rows, (row) => {
    const title = requireQuery(row, "exact_title_file").query;
    return `${row.knowledgeBaseId}\u001f${normalizeTitle(title)}`;
  });

  for (const group of [...titleGroups.values()].filter((value) => value.length > 1)) {
    const ordered = [...group].sort(compareAlias);
    const query = requireQuery(ordered[0], "exact_title_file");
    cases.push(existingCase({
      category: "duplicate_title",
      discriminator: sha256(`${ordered[0].knowledgeBaseId}\u001f${normalizeTitle(query.query)}`).slice(0, 16),
      rows: ordered,
      query,
      expectation: {
        kind: "all_duplicate_title_sources_returned",
        requiredSourceFileIds: ordered.map((row) => row.sourceFileId).sort()
      }
    }));
  }

  for (const pair of similarTitlePairs(rows)) {
    const leftQuery = requireQuery(pair.left, "exact_title_file");
    cases.push(existingCase({
      category: "similar_file",
      discriminator: `${pair.left.alias}:${pair.right.alias}`,
      rows: [pair.left, pair.right],
      query: leftQuery,
      expectation: {
        kind: "distinct_similar_sources_remain_individually_retrievable",
        pairedQuerySha256: requireQuery(pair.right, "exact_title_file").querySha256,
        titleBigramJaccard: round(pair.score)
      }
    }));
  }

  for (const row of rows) {
    const exactPath = requireQuery(row, "exact_path_file");
    const lexical = requireQuery(row, "lexical_file");
    const natural = requireQuery(row, "natural_sentence_hybrid");
    const graph = requireQuery(row, "exact_title_graph");
    const reranked = requireQuery(row, "natural_sentence_hybrid_reranked");
    const script = classifyScript(`${requireQuery(row, "exact_title_file").query} ${lexical.query}`);

    if (row.sourcePath.split("/").filter(Boolean).length >= 3) {
      cases.push(existingCase({
        category: "nested_path",
        discriminator: row.alias,
        rows: [row],
        query: exactPath,
        expectation: { kind: "exact_nested_path_resolves_to_owned_source" }
      }));
    }

    if (script !== "none") {
      cases.push(existingCase({
        category: "multilingual",
        discriminator: row.alias,
        rows: [row],
        query: lexical,
        expectation: { kind: "language_specific_source_is_retrievable", script }
      }));
    }

    if (script === "han" || script === "mixed") {
      cases.push(existingCase({
        category: "cjk_jieba",
        discriminator: row.alias,
        rows: [row],
        query: lexical,
        expectation: {
          kind: "cjk_source_is_retrievable_with_jieba_evidence",
          requiredEvidenceFamily: "jieba"
        }
      }));
    }

    const missingMetadataFields = row.filterDispositions
      .filter((item) => item.status === "not_applicable")
      .map((item) => item.field)
      .sort();
    if (missingMetadataFields.length > 0) {
      cases.push(existingCase({
        category: "sparse_or_malformed_metadata",
        discriminator: row.alias,
        rows: [row],
        query: exactPath,
        expectation: {
          kind: "optional_metadata_does_not_block_source_retrieval",
          nonApplicableFields: missingMetadataFields,
          metadataClassification: manifestByAlias.get(row.alias)?.metadataClassification ?? null
        }
      }));
    }

    for (const query of row.queries.filter((item) => item.variant.startsWith("filter_okf_"))) {
      cases.push(existingCase({
        category: "filter",
        discriminator: `${row.alias}:${query.variant}`,
        rows: [row],
        query,
        expectation: { kind: "applicable_okf_filter_preserves_owned_source" }
      }));
    }

    addEvidenceFamilyCase(cases, row, natural, "entity", "entity_vector");
    addEvidenceFamilyCase(cases, row, natural, "relationship", "relationship_vector");
    addEvidenceFamilyCase(cases, row, natural, "community_theme", "community_vector");

    if (
      graph.parameters?.graphDepth === "2"
      && graph.graphStatus === "available"
      && graph.evidenceStatus?.completedFamilies?.includes("file_graph")
    ) {
      cases.push(existingCase({
        category: "multi_hop",
        discriminator: row.alias,
        rows: [row],
        query: graph,
        expectation: {
          kind: "depth_two_graph_search_remains_source_grounded",
          graphDepth: 2,
          requiredEvidenceFamily: "file_graph"
        }
      }));
    }

    if (reranked.parameters?.rerank === "true") {
      cases.push(existingCase({
        category: "threshold",
        discriminator: row.alias,
        rows: [row],
        query: reranked,
        expectation: {
          kind: "request_scoped_reranker_threshold_is_applied_safely",
          rerankScoreThreshold: Number(reranked.parameters.rerankScoreThreshold)
        }
      }));
    }
  }

  for (const group of [...titleGroups.values()].filter((value) => value.length > 1)) {
    const ordered = [...group].sort(compareAlias);
    const query = requireQuery(ordered[0], "exact_title_file");
    const common = {
      rows: ordered,
      query,
      execution: "live_http",
      parameters: {
        mode: "file",
        graphDepth: "0",
        limit: "1",
        rerank: "false"
      }
    };
    cases.push(specialCase({
      ...common,
      category: "pagination",
      discriminator: sha256(`${ordered[0].knowledgeBaseId}\u001f${normalizeTitle(query.query)}`).slice(0, 16),
      expectation: {
        kind: "first_page_has_one_owned_result_and_continuation",
        requiredSourceFileIds: ordered.map((row) => row.sourceFileId).sort()
      }
    }));
    cases.push(specialCase({
      ...common,
      category: "cursor",
      discriminator: sha256(`${ordered[0].knowledgeBaseId}\u001f${normalizeTitle(query.query)}`).slice(0, 16),
      expectation: {
        kind: "cursor_continues_same_scope_without_duplicates",
        requiredSourceFileIds: ordered.map((row) => row.sourceFileId).sort()
      }
    }));
  }

  const knowledgeBaseIds = [...knowledgeBaseRows.keys()].sort();
  for (const knowledgeBaseId of knowledgeBaseIds) {
    const anchored = [...knowledgeBaseRows.get(knowledgeBaseId)].sort(compareAlias)[0];
    const query = `focowiki-no-result-${sha256(`${report.corpus.manifestSha256}:${knowledgeBaseId}`).slice(0, 24)}`;
    cases.push(specialCase({
      category: "no_result",
      discriminator: anchored.alias,
      rows: [anchored],
      query: { query, querySha256: sha256(query) },
      execution: "live_http",
      parameters: {
        scope: "path",
        mode: "file",
        graphDepth: "0",
        limit: "20",
        rerank: "false"
      },
      expectation: { kind: "no_candidates_and_no_false_positive" }
    }));
  }

  if (knowledgeBaseIds.length < 2) {
    throw new Error("Comprehensive search cross-knowledge-base cases require two knowledge bases");
  }
  for (const row of rows) {
    const query = requireQuery(row, "exact_path_file");
    for (const foreignKnowledgeBaseId of knowledgeBaseIds.filter((id) => id !== row.knowledgeBaseId)) {
      cases.push(specialCase({
        category: "cross_knowledge_base",
        discriminator: `${row.alias}:${sha256(foreignKnowledgeBaseId).slice(0, 12)}`,
        rows: [row],
        query,
        execution: "live_http",
        knowledgeBaseId: foreignKnowledgeBaseId,
        parameters: {
          scope: "path",
          mode: "file",
          graphDepth: "0",
          limit: "20",
          rerank: "false"
        },
        expectation: {
          kind: "foreign_scope_never_returns_source",
          forbiddenSourceFileIds: [row.sourceFileId]
        }
      }));
    }
  }

  cases.sort(compareCase);
  const plan = {
    schemaVersion: 1,
    format: "focowiki-comprehensive-search-special-case-plan-v1",
    coverageMode: "item_by_item",
    provider: report.provider,
    providerReportSha256: sha256(JSON.stringify(report)),
    corpusManifestSha256: report.corpus.manifestSha256,
    counts: {
      sourceFiles: rows.length,
      cases: cases.length,
      categories: Object.fromEntries(COMPREHENSIVE_SEARCH_SPECIAL_CATEGORIES.map((category) => [
        category,
        cases.filter((item) => item.category === category).length
      ]))
    },
    cases
  };
  validateComprehensiveSearchSpecialCasePlan(plan);
  return plan;
}

export function validateComprehensiveSearchSpecialCasePlan(plan) {
  if (
    !plan || plan.schemaVersion !== 1
    || plan.format !== "focowiki-comprehensive-search-special-case-plan-v1"
    || plan.coverageMode !== "item_by_item"
    || !/^[a-f0-9]{64}$/u.test(plan.providerReportSha256 ?? "")
    || !Array.isArray(plan.cases)
  ) {
    throw new Error("Comprehensive search special-case plan or provider report hash is invalid");
  }
  const ids = new Set();
  const observedCategories = new Set();
  for (const item of plan.cases) {
    if (!SPECIAL_CATEGORY_SET.has(item?.category)) {
      throw new Error(`Comprehensive search special-case category is invalid: ${item?.category}`);
    }
    observedCategories.add(item.category);
    const id = requireString(item.id, "case ID");
    if (ids.has(id)) throw new Error(`Comprehensive search special-case has duplicate case ID: ${id}`);
    ids.add(id);
    const query = requireString(item.query, "case query");
    if (item.querySha256 !== sha256(query)) {
      throw new Error(`Comprehensive search special-case has an invalid query hash: ${id}`);
    }
    if (!/^[a-f0-9]{64}$/u.test(item.querySha256)) {
      throw new Error(`Comprehensive search special-case has an invalid query hash: ${id}`);
    }
    requireString(item.knowledgeBaseId, "case knowledge base ID");
    const aliases = requireArray(item.sourceAliases, "case source aliases");
    if (
      aliases.length === 0
      || new Set(aliases).size !== aliases.length
      || aliases.some((alias) => typeof alias !== "string" || alias === "")
    ) {
      throw new Error(`Comprehensive search special-case source ownership is invalid: ${id}`);
    }
    if (!["existing_report", "live_http"].includes(item.execution)) {
      throw new Error(`Comprehensive search special-case execution is invalid: ${id}`);
    }
    requireRecord(item.parameters, "case parameters");
    requireRecord(item.expectation, "case expectation");
  }
  for (const category of COMPREHENSIVE_SEARCH_SPECIAL_CATEGORIES) {
    if (!observedCategories.has(category)) {
      throw new Error(`Comprehensive search special-case plan is missing category: ${category}`);
    }
  }
  if (
    plan.counts?.cases !== plan.cases.length
    || COMPREHENSIVE_SEARCH_SPECIAL_CATEGORIES.some((category) =>
      plan.counts?.categories?.[category]
        !== plan.cases.filter((item) => item.category === category).length)
  ) {
    throw new Error("Comprehensive search special-case counts do not reconcile");
  }
  return { ok: true, caseCount: plan.cases.length };
}

export function validateComprehensiveSearchSpecialCaseInputs(input) {
  const plan = input?.plan;
  const report = requireProviderReport(input?.providerReport);
  validateComprehensiveSearchSpecialCasePlan(plan);
  if (
    report.provider !== plan.provider
    || report.corpus.manifestSha256 !== plan.corpusManifestSha256
    || sha256(JSON.stringify(report)) !== plan.providerReportSha256
  ) {
    throw new Error(
      "Comprehensive search special-case inputs do not share one green provider run"
    );
  }
  return { ok: true };
}

export function evaluateComprehensiveExistingSpecialCase(input) {
  const item = requireRecord(input?.item, "existing case");
  if (item.execution !== "existing_report") {
    throw new Error("Comprehensive search special case does not use existing report evidence");
  }
  const report = requireProviderReport(input?.providerReport);
  const rowByAlias = new Map(report.rows.map((row) => [row.alias, row]));
  const rows = item.sourceAliases.map((alias) => {
    const row = rowByAlias.get(alias);
    if (!row || row.sourceRead?.matched !== true) {
      throw new Error(`Comprehensive search special-case source evidence is incomplete: ${alias}`);
    }
    return row;
  });
  const queries = rows.map((row) => {
    const query = row.queries.find((candidate) =>
      candidate.variant === item.existingVariant);
    if (
      !query || query.status !== 200 || query.found !== true
      || query.pathMatched !== true || query.modeMatches !== true
      || query.scopeMatches !== true || query.rerankerMatches !== true
    ) {
      throw new Error(`Comprehensive search special-case query evidence is incomplete: ${item.id}`);
    }
    return query;
  });
  if (!queries.some((query) => query.querySha256 === item.querySha256)) {
    throw new Error(`Comprehensive search special-case query identity does not match: ${item.id}`);
  }

  const expectation = requireRecord(item.expectation, "existing case expectation");
  if (Array.isArray(expectation.requiredSourceFileIds)) {
    const returned = new Set(queries[0].returnedSourceFileIds);
    if (expectation.requiredSourceFileIds.some((sourceFileId) => !returned.has(sourceFileId))) {
      throw new Error(`Comprehensive search special-case required source is missing: ${item.id}`);
    }
  }
  if (typeof expectation.requiredEvidenceFamily === "string") {
    if (queries.some((query) =>
      !query.evidenceStatus?.completedFamilies?.includes(expectation.requiredEvidenceFamily))) {
      throw new Error(`Comprehensive search special-case required evidence family is missing: ${item.id}`);
    }
  }
  if (typeof expectation.requiredDegradedEvidenceFamily === "string") {
    if (queries.some((query) =>
      !query.evidenceStatus?.degradedFamilies?.includes(
        expectation.requiredDegradedEvidenceFamily
      )
        || query.semanticStatus?.state !== "degraded"
        || query.semanticStatus?.safeCode !== expectation.semanticSafeCode)) {
      throw new Error(
        `Comprehensive search special-case degraded evidence family is missing: ${item.id}`
      );
    }
  }
  if (item.category === "similar_file") {
    if (new Set(rows.map((row) => row.sourceFileId)).size !== rows.length) {
      throw new Error(`Comprehensive search similar-file ownership collapsed: ${item.id}`);
    }
    if (!queries.some((query) => query.querySha256 === expectation.pairedQuerySha256)) {
      throw new Error(`Comprehensive search similar-file paired query is missing: ${item.id}`);
    }
  }
  if (item.category === "nested_path" && rows.some((row) =>
    row.sourcePath.split("/").filter(Boolean).length < 3)) {
    throw new Error(`Comprehensive search nested-path case is not nested: ${item.id}`);
  }
  if (item.category === "sparse_or_malformed_metadata") {
    const dispositions = new Set(rows[0].filterDispositions
      .filter((value) => value.status === "not_applicable")
      .map((value) => value.field));
    if (expectation.nonApplicableFields.some((field) => !dispositions.has(field))) {
      throw new Error(`Comprehensive search sparse metadata disposition is missing: ${item.id}`);
    }
  }
  if (item.category === "filter") {
    const filterFields = ["okfStatus", "okfTrustTier", "okfFreshness"];
    if (!filterFields.some((field) => typeof queries[0].parameters?.[field] === "string")) {
      throw new Error(`Comprehensive search filter case is not filtered: ${item.id}`);
    }
  }
  if (item.category === "multi_hop" && queries.some((query) =>
    query.parameters?.graphDepth !== "2" || query.graphStatus !== "available")) {
    throw new Error(`Comprehensive search multi-hop evidence is incomplete: ${item.id}`);
  }
  if (item.category === "threshold" && queries.some((query) =>
    query.parameters?.rerank !== "true"
      || Number(query.parameters.rerankScoreThreshold)
        !== expectation.rerankScoreThreshold)) {
    throw new Error(`Comprehensive search threshold evidence is incomplete: ${item.id}`);
  }

  const observation = {
    sourceAliases: [...item.sourceAliases],
    sourceFileIds: rows.map((row) => row.sourceFileId).sort(),
    querySha256: item.querySha256,
    queryVariants: queries.map((query) => query.variant),
    returnedSourceFileCounts: queries.map((query) => query.returnedSourceFileIds.length),
    requiredEvidenceFamily: expectation.requiredEvidenceFamily ?? null,
    requiredDegradedEvidenceFamily: expectation.requiredDegradedEvidenceFamily ?? null,
    semanticStates: queries.map((query) => query.semanticStatus?.state ?? null),
    rerankerStates: queries.map((query) => query.rerankerStatus?.state ?? null),
    sourceReadsMatched: rows.every((row) => row.sourceRead.matched === true)
  };
  return {
    caseId: item.id,
    category: item.category,
    execution: item.execution,
    ok: true,
    observation,
    evidenceHash: sha256(JSON.stringify(observation))
  };
}

export function evaluateComprehensiveLiveSpecialCase(input) {
  const item = requireRecord(input?.item, "live case");
  if (item.execution !== "live_http") {
    throw new Error("Comprehensive search special case does not use live HTTP evidence");
  }
  const pages = requireArray(input?.pages, "live case pages");
  if (pages.length === 0) {
    throw new Error(`Comprehensive search live case has no pages: ${item.id}`);
  }
  if (!(input?.sourceReads instanceof Map)) {
    throw new Error("Comprehensive search live case source reads must be a map");
  }
  const observations = pages.map((page, index) => validateLivePage({
    item,
    page,
    pageIndex: index,
    sourceReads: input.sourceReads
  }));
  const returnedItems = observations.flatMap((page) => page.returnedItems);
  const returnedSourceFileIds = returnedItems.map((value) => value.sourceFileId);
  if (new Set(returnedSourceFileIds).size !== returnedSourceFileIds.length) {
    throw new Error(`Comprehensive search live cursor returned a duplicate source: ${item.id}`);
  }
  const expectation = requireRecord(item.expectation, "live case expectation");

  if (item.category === "pagination") {
    if (
      pages.length !== 1 || returnedItems.length !== 1
      || typeof pages[0].body?.nextCursor !== "string"
      || pages[0].body?.resultSummary?.hasMore !== true
      || !expectation.requiredSourceFileIds.includes(returnedItems[0].sourceFileId)
    ) {
      throw new Error(`Comprehensive search pagination evidence is incomplete: ${item.id}`);
    }
  } else if (item.category === "cursor") {
    if (pages.length < 2 || pages.at(-1)?.body?.nextCursor !== null) {
      throw new Error(`Comprehensive search cursor did not reach a terminal page: ${item.id}`);
    }
    const cursors = pages.slice(0, -1).map((page) => page.body?.nextCursor);
    if (
      cursors.some((cursor) => typeof cursor !== "string")
      || new Set(cursors).size !== cursors.length
      || expectation.requiredSourceFileIds.some((sourceFileId) =>
        !returnedSourceFileIds.includes(sourceFileId))
    ) {
      throw new Error(`Comprehensive search cursor continuation is incomplete: ${item.id}`);
    }
  } else if (item.category === "no_result") {
    if (
      pages.length !== 1 || returnedItems.length !== 0
      || pages[0].body?.nextCursor !== null
      || pages[0].body?.searchStatus !== "no_candidates"
    ) {
      throw new Error(`Comprehensive search no-result control has a false positive: ${item.id}`);
    }
  } else if (item.category === "cross_knowledge_base") {
    if (expectation.forbiddenSourceFileIds.some((sourceFileId) =>
      returnedSourceFileIds.includes(sourceFileId))) {
      throw new Error(`Comprehensive search cross-knowledge-base source leaked: ${item.id}`);
    }
  } else {
    throw new Error(`Comprehensive search live category is unsupported: ${item.category}`);
  }

  const observation = {
    pageCount: pages.length,
    statusCodes: pages.map((page) => page.status),
    latencyMs: pages.map((page) => page.latencyMs),
    returnedSourceFileIds,
    returnedItemCount: returnedItems.length,
    cursorHashes: pages.map((page) => typeof page.body?.nextCursor === "string"
      ? sha256(page.body.nextCursor)
      : null),
    sourceReadsMatched: returnedItems.every((value) => value.sourceReadMatched === true),
    semanticStates: pages.map((page) => page.body.semanticStatus.state),
    rerankerStates: pages.map((page) => page.body.rerankerStatus.state)
  };
  return {
    caseId: item.id,
    category: item.category,
    execution: item.execution,
    ok: true,
    observation,
    evidenceHash: sha256(JSON.stringify(observation))
  };
}

function validateLivePage(input) {
  const page = requireRecord(input.page, "live page");
  const body = requireRecord(page.body, "live page body");
  if (page.status !== 200 || !Number.isFinite(page.latencyMs) || page.latencyMs < 0) {
    throw new Error(`Comprehensive search live HTTP status or latency is invalid: ${input.item.id}`);
  }
  const items = requireArray(body.items, "live page items");
  const expectedMode = input.item.parameters?.mode ?? "hybrid";
  if (
    body.searchMode !== expectedMode
    || body.query?.cursorProvided !== (input.pageIndex > 0)
    || ![null, "string"].includes(body.nextCursor === null ? null : typeof body.nextCursor)
    || body.resultSummary?.resultCount !== items.length
    || body.resultSummary?.hasMore !== (body.nextCursor !== null)
    || body.searchStatus !== (items.length === 0 ? "no_candidates" : "ok")
  ) {
    throw new Error(`Comprehensive search live cursor or result summary is invalid: ${input.item.id}`);
  }
  validateSemanticStatus(body.semanticStatus, input.item.id);
  validateEvidenceStatus(body.evidenceStatus, input.item.id);
  const reranker = evaluateExpectedRerankerOutcome({
    requested: input.item.parameters?.rerank === "true",
    status: body.rerankerStatus
  });
  if (!reranker.matched) {
    throw new Error(`Comprehensive search live reranker state is invalid: ${input.item.id}`);
  }
  if (
    (expectedMode === "file" && body.graphStatus !== "disabled_for_file_mode")
    || (expectedMode !== "file" && body.graphStatus !== "available")
  ) {
    throw new Error(`Comprehensive search live graph state is invalid: ${input.item.id}`);
  }
  for (const item of items) {
    const sourceRead = input.sourceReads.get(item.sourceFileId);
    const byIdPath = item.readActions?.fileContentById;
    const byPathPath = item.readActions?.fileContentByPath;
    if (
      !sourceRead || typeof byIdPath !== "string" || typeof byPathPath !== "string"
      || sourceRead.readActionsSha256
        !== sha256(JSON.stringify({ byIdPath, byPathPath }))
    ) {
      throw new Error(`Comprehensive search live source read identity changed: ${input.item.id}`);
    }
  }
  return {
    returnedItems: evaluateComprehensiveReturnedItems({
      knowledgeBaseId: input.item.knowledgeBaseId,
      items,
      sourceReads: input.sourceReads
    })
  };
}

function validateSemanticStatus(status, caseId) {
  if (
    !status || !["ready", "degraded", "unavailable"].includes(status.state)
    || (status.state === "ready" && status.safeCode !== null)
    || (status.state !== "ready" && !SEMANTIC_SAFE_CODES.has(status.safeCode))
  ) {
    throw new Error(`Comprehensive search live semantic state is invalid: ${caseId}`);
  }
}

function validateEvidenceStatus(status, caseId) {
  if (!status || !Array.isArray(status.completedFamilies)
    || !Array.isArray(status.degradedFamilies)) {
    throw new Error(`Comprehensive search live evidence state is invalid: ${caseId}`);
  }
  const combined = [...status.completedFamilies, ...status.degradedFamilies];
  if (
    new Set(combined).size !== combined.length
    || combined.some((family) => !SEARCH_EVIDENCE_FAMILIES.has(family))
  ) {
    throw new Error(`Comprehensive search live evidence state is invalid: ${caseId}`);
  }
}

function addEvidenceFamilyCase(cases, row, query, category, evidenceFamily) {
  const completed = query.evidenceStatus?.completedFamilies?.includes(evidenceFamily) === true;
  const degraded = query.evidenceStatus?.degradedFamilies?.includes(evidenceFamily) === true;
  if (!completed && !degraded) return;
  cases.push(existingCase({
    category,
    discriminator: row.alias,
    rows: [row],
    query,
    expectation: completed
      ? {
          kind: "semantic_family_completes_with_source_grounding",
          requiredEvidenceFamily: evidenceFamily
        }
      : {
          kind: "semantic_family_degrades_safely",
          requiredDegradedEvidenceFamily: evidenceFamily,
          semanticSafeCode: query.semanticStatus?.safeCode ?? null
        }
  }));
}

function existingCase(input) {
  return specialCase({ ...input, execution: "existing_report" });
}

function specialCase(input) {
  const rows = requireArray(input.rows, "case source rows");
  const query = typeof input.query === "string"
    ? { query: input.query, querySha256: sha256(input.query), parameters: input.parameters }
    : input.query;
  const parameters = input.parameters ?? query.parameters ?? {};
  const category = requireString(input.category, "case category");
  const discriminator = requireString(input.discriminator, "case discriminator");
  return {
    id: `search-special:${category}:${discriminator}`,
    category,
    execution: input.execution,
    knowledgeBaseId: input.knowledgeBaseId ?? rows[0].knowledgeBaseId,
    sourceAliases: rows.map((row) => row.alias).sort(),
    sourceFileIds: rows.map((row) => row.sourceFileId).sort(),
    query: query.query,
    querySha256: query.querySha256,
    parameters: structuredClone(parameters),
    existingVariant: input.execution === "existing_report" ? query.variant : null,
    expectation: structuredClone(input.expectation)
  };
}

function similarTitlePairs(rows) {
  const pairs = new Map();
  for (const left of rows) {
    const leftTitle = normalizeTitle(requireQuery(left, "exact_title_file").query);
    let best = null;
    for (const right of rows) {
      if (left === right || left.knowledgeBaseId !== right.knowledgeBaseId) continue;
      const rightTitle = normalizeTitle(requireQuery(right, "exact_title_file").query);
      if (leftTitle === rightTitle) continue;
      const score = bigramJaccard(leftTitle, rightTitle);
      if (!best || score > best.score || (score === best.score && right.alias < best.right.alias)) {
        best = { left, right, score };
      }
    }
    if (best && best.score >= SIMILAR_TITLE_MINIMUM_BIGRAM_JACCARD) {
      const aliases = [best.left.alias, best.right.alias].sort();
      const key = aliases.join("\u001f");
      if (!pairs.has(key)) {
        pairs.set(key, aliases[0] === best.left.alias
          ? best
          : { left: best.right, right: best.left, score: best.score });
      }
    }
  }
  return [...pairs.values()].sort((left, right) =>
    left.left.alias.localeCompare(right.left.alias, "en")
      || left.right.alias.localeCompare(right.right.alias, "en"));
}

function bigramJaccard(left, right) {
  const leftSet = bigrams(left);
  const rightSet = bigrams(right);
  let intersection = 0;
  for (const value of leftSet) if (rightSet.has(value)) intersection += 1;
  return intersection / Math.max(1, leftSet.size + rightSet.size - intersection);
}

function bigrams(value) {
  const characters = [...value.replace(/\s+/gu, "")];
  if (characters.length < 2) return new Set(characters);
  return new Set(characters.slice(0, -1).map((character, index) =>
    `${character}${characters[index + 1]}`));
}

function classifyScript(value) {
  const hasHan = /\p{Script=Han}/u.test(value);
  const hasLatin = /\p{Script=Latin}/u.test(value);
  if (hasHan && hasLatin) return "mixed";
  if (hasHan) return "han";
  if (hasLatin) return "latin";
  return "none";
}

function requireProviderReport(report) {
  if (
    !report || report.format !== "focowiki-comprehensive-search-provider-e2e-v1"
    || report.ok !== true || typeof report.provider !== "string"
    || !/^[a-f0-9]{64}$/u.test(report.corpus?.manifestSha256 ?? "")
    || !Array.isArray(report.rows) || report.rows.length === 0
  ) {
    throw new Error("Comprehensive search provider report is invalid for special cases");
  }
  return report;
}

function validateProviderRow(row) {
  requireString(row?.alias, "provider row alias");
  requireString(row?.knowledgeBaseId, "provider row knowledge base ID");
  requireString(row?.sourceFileId, "provider row source file ID");
  requireString(row?.sourcePath, "provider row source path");
  requireArray(row?.queries, "provider row queries");
  requireArray(row?.filterDispositions, "provider row filter dispositions");
}

function requireQuery(row, variant) {
  const query = row.queries.find((item) => item.variant === variant);
  if (
    !query || typeof query.query !== "string" || query.query === ""
    || query.querySha256 !== sha256(query.query)
    || query.status !== 200 || query.found !== true
  ) {
    throw new Error(`Comprehensive search special-case query is incomplete: ${row.alias}:${variant}`);
  }
  return query;
}

function normalizeTitle(value) {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("und");
}

function compareAlias(left, right) {
  return left.alias.localeCompare(right.alias, "en");
}

function compareCase(left, right) {
  return left.category.localeCompare(right.category, "en")
    || left.id.localeCompare(right.id, "en");
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`Comprehensive search ${label} must be an array`);
  return value;
}

function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Comprehensive search ${label} must be an object`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Comprehensive search ${label} is required`);
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function round(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}
