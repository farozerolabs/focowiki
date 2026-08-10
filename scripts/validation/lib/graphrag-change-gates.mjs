const SDK_IMPORT_PATTERN = /(?:from\s+graphrag\b|import\s+graphrag\b|from\s+["']graphrag|import\s+[^;]*["']graphrag)/u;
const PROVIDER_IMPORT_PATTERN = /(?:@opensearch-project\/opensearch|from\s+["']meilisearch["'])/u;
const DATABASE_IMPORT_PATTERN = /(?:from\s+["']postgres["']|\/postgres-|\/db\/|infrastructure\/postgres)/u;
const S3_IMPORT_PATTERN = /(?:@aws-sdk\/client-s3|\/s3-|infrastructure\/s3)/u;
const S3_KEY_PATTERN = /(?:objectKey|s3Key|bucketKey)\s*[:=]/u;
const DOMAIN_SPECIFIC_PATTERN = /\b(?:legal|statute|plaintiff|defendant|case[ -]law|court[ -]opinion)\b|(?:法律|法规|法院|原告|被告|判决书|案件类型)/iu;

export function validateSemanticArchitecture(files) {
  const failures = [];
  for (const file of files) {
    const path = normalizePath(file.path);
    const source = String(file.source ?? "");
    const isPythonAdapter = path.startsWith("apps/api/python/graphrag_adapter/");
    const isInfrastructure = path.includes("/semantic/infrastructure/")
      || path.startsWith("apps/api/src/infrastructure/");
    const isApplicationOrDomain = path.includes("/semantic/application/")
      || path.includes("/semantic/domain/");
    const isPresentation = path.includes("/semantic/presentation/");

    if (SDK_IMPORT_PATTERN.test(source) && !isPythonAdapter) {
      failures.push(failure(path, "GRAPHRAG_SDK_OUTSIDE_ADAPTER"));
    }
    if (PROVIDER_IMPORT_PATTERN.test(source) && !isInfrastructure) {
      failures.push(failure(path, "SEARCH_PROVIDER_OUTSIDE_ADAPTER"));
    }
    if (isApplicationOrDomain && DATABASE_IMPORT_PATTERN.test(source)) {
      failures.push(failure(path, "DATABASE_ACCESS_OUTSIDE_INFRASTRUCTURE"));
    }
    if (isApplicationOrDomain && (S3_IMPORT_PATTERN.test(source) || S3_KEY_PATTERN.test(source))) {
      failures.push(failure(path, "S3_ACCESS_OUTSIDE_INFRASTRUCTURE"));
    }
    if (isPresentation && /(?:\/repositories?\/|\/infrastructure\/|postgres-|s3-)/u.test(source)) {
      failures.push(failure(path, "PRESENTATION_CROSSES_APPLICATION_BOUNDARY"));
    }
  }
  return failures;
}

export function validateDomainNeutralSemanticSources(files) {
  const failures = [];
  for (const file of files) {
    const path = normalizePath(file.path);
    if (isTestData(path) || !isSemanticSurface(path)) continue;
    const source = String(file.source ?? "");
    if (DOMAIN_SPECIFIC_PATTERN.test(source)) {
      failures.push(failure(path, "DOMAIN_SPECIFIC_PRODUCTION_BEHAVIOR"));
    }
  }
  return failures;
}

export function compareSemanticPublicStructure(baseline, candidate) {
  const failures = [];
  compareSet("GENERATED_PATH_SET_CHANGED", baseline.generatedPaths, candidate.generatedPaths, failures);
  compareSet("NAVIGATION_TOPOLOGY_CHANGED", baseline.navigationEdges, candidate.navigationEdges, failures);
  compareSet("SOURCE_PAGE_PATHS_CHANGED", baseline.sourcePagePaths, candidate.sourcePagePaths, failures);
  if (baseline.stableLeafPattern !== candidate.stableLeafPattern) {
    failures.push(failure("public-structure", "STABLE_LEAF_SCHEME_CHANGED"));
  }
  const baselineBodies = stableEntries(baseline.sourceBodiesSha256);
  const candidateBodies = stableEntries(candidate.sourceBodiesSha256);
  if (JSON.stringify(baselineBodies) !== JSON.stringify(candidateBodies)) {
    failures.push(failure("public-structure", "SOURCE_BODY_CHANGED"));
  }
  return failures;
}

export function validateIncrementalSemanticTrace(trace) {
  if (trace.mode === "maintenance") return [];
  const failures = [];
  if (trace.graphReadScope === "knowledge_base") {
    failures.push(failure(trace.operation, "FULL_CORPUS_GRAPH_READ"));
  }
  if (trace.vectorWriteScope === "knowledge_base") {
    failures.push(failure(trace.operation, "FULL_VECTOR_REWRITE"));
  }
  const affected = new Set(trace.affectedSourceFilePublicIds ?? []);
  for (const sourceFilePublicId of trace.sourceReads ?? []) {
    if (!affected.has(sourceFilePublicId)) {
      failures.push(failure(trace.operation, "UNRELATED_SOURCE_REREAD", sourceFilePublicId));
    }
  }
  for (const sourceFilePublicId of trace.modelCalls ?? []) {
    if (!affected.has(sourceFilePublicId)) {
      failures.push(failure(trace.operation, "UNRELATED_MODEL_CALL", sourceFilePublicId));
    }
  }
  for (const ownerPublicId of trace.vectorWriteOwnerPublicIds ?? []) {
    if (!(trace.affectedOwnerPublicIds ?? []).includes(ownerPublicId)) {
      failures.push(failure(trace.operation, "UNRELATED_VECTOR_WRITE", ownerPublicId));
    }
  }
  return failures;
}

function isSemanticSurface(path) {
  return path.includes("/semantic/")
    || path.includes("graphrag")
    || path.includes("semantic-");
}

function isTestData(path) {
  return /(?:^|\/)(?:test|tests|fixtures|samples)(?:\/|$)/u.test(path);
}

function compareSet(code, left = [], right = [], failures) {
  const first = [...new Set(left)].sort();
  const second = [...new Set(right)].sort();
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    failures.push(failure("public-structure", code));
  }
}

function stableEntries(value = {}) {
  return Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
}

function normalizePath(value) {
  return String(value).replaceAll("\\", "/");
}

function failure(path, code, ownerPublicId = null) {
  return { path, code, ...(ownerPublicId === null ? {} : { ownerPublicId }) };
}
