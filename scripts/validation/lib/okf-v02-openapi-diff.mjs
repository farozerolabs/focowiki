import { createHash } from "node:crypto";

const SEARCH_PATH =
  "/openapi/v2/knowledge-bases/{knowledgeBaseId}/files/search";

export function createOkfV02OpenApiDiff(document, baseline) {
  const before = baseline.developerOpenApi;
  const operations = collectOperations(document);
  const operationIds = operations.map((item) => item.operationId).sort();
  const signatures = operations.map((item) =>
    `${item.method} ${item.path} ${item.operationId}`
  );
  const search = document.paths?.[SEARCH_PATH]?.get;
  const searchParameters = (search?.parameters ?? []).map((item) => item.name);
  const errors = document.components?.schemas?.Error?.properties?.error
    ?.properties?.code?.enum ?? [];
  const generatedFileKeys = propertyKeys(document, "GeneratedFile");
  const searchResultKeys = propertyKeys(document, "FileSearchResult");
  const okfSignalKeys = propertyKeys(document, "OkfSignals");
  const directExample = successExample(
    document.paths?.["/openapi/v2/knowledge-bases/{knowledgeBaseId}/files/{fileId}"]?.get
  );
  const searchExample = successExample(search);
  const unchangedOperations = operationIds.length === before.operationCount
    && arraysEqual(operationIds, [...before.operationIds].sort())
    && sha256(signatures) === before.operationSignaturesSha256;
  const unchangedErrors = arraysEqual(errors, before.errorCodes);
  const addedParameters = searchParameters.filter((item) =>
    !before.searchParameterNames.includes(item)
  );
  const removedParameters = before.searchParameterNames.filter((item) =>
    !searchParameters.includes(item)
  );
  const generatedFileAdditions = generatedFileKeys.filter((item) =>
    !before.generatedFileResponseKeys.includes(item)
  );
  const searchResultAdditions = searchResultKeys.filter((item) =>
    !before.searchResultKeys.includes(item)
  );
  const examplesUpdated = Boolean(
    directExample?.file?.okfSignals
    && searchExample?.items?.[0]?.okfSignals
    && searchExample?.query?.okfStatus === null
    && searchExample?.query?.okfTrustTier === null
    && searchExample?.query?.okfFreshness === null
  );
  const expectedSignals = [
    "effectiveStatus",
    "generatedAt",
    "generatedAtSource",
    "isStale",
    "latestVerifiedAt",
    "sourceCount",
    "staleAfter",
    "trustTier"
  ];
  const additive = unchangedOperations
    && unchangedErrors
    && arraysEqual(addedParameters, [
      "okfStatus", "okfTrustTier", "okfFreshness"
    ])
    && removedParameters.length === 0
    && arraysEqual(generatedFileAdditions, ["okfSignals"])
    && arraysEqual(searchResultAdditions, ["okfSignals"])
    && arraysEqual(okfSignalKeys.sort(), expectedSignals)
    && examplesUpdated;

  return {
    compatibility: additive ? "additive" : "review_required",
    pathsMethodsAndOperationIds: {
      beforeCount: before.operationCount,
      afterCount: operations.length,
      unchanged: unchangedOperations
    },
    parameters: { added: addedParameters, removed: removedParameters },
    responseFields: {
      GeneratedFile: { added: generatedFileAdditions },
      FileSearchResult: { added: searchResultAdditions },
      OkfSignals: okfSignalKeys.sort()
    },
    examples: { updated: examplesUpdated },
    errors: { unchanged: unchangedErrors, values: errors }
  };
}

export function reviewedOpenApiSurface(document) {
  const operations = collectOperations(document);
  const search = document.paths?.[SEARCH_PATH]?.get;
  return {
    operations: operations.map((item) =>
      `${item.method} ${item.path} ${item.operationId}`
    ),
    searchParameterNames: (search?.parameters ?? []).map((item) => item.name),
    searchParameters: search?.parameters ?? [],
    generatedFileKeys: propertyKeys(document, "GeneratedFile"),
    searchResultKeys: propertyKeys(document, "FileSearchResult"),
    fileSearchResponseKeys: propertyKeys(document, "FileSearchResponse"),
    okfSignalSchema: document.components?.schemas?.OkfSignals ?? null,
    fileSearchResultSchema:
      document.components?.schemas?.FileSearchResult ?? null,
    fileSearchQueryContextSchema:
      document.components?.schemas?.FileSearchQueryContext ?? null,
    semanticStatusSchema:
      document.components?.schemas?.FileSearchResponse?.properties?.semanticStatus ?? null,
    evidenceStatusSchema:
      document.components?.schemas?.FileSearchResponse?.properties?.evidenceStatus ?? null,
    rerankerStatusSchema:
      document.components?.schemas?.FileSearchResponse?.properties?.rerankerStatus ?? null,
    fileSearchResponseSchema:
      document.components?.schemas?.FileSearchResponse ?? null,
    errorCodes: document.components?.schemas?.Error?.properties?.error
      ?.properties?.code?.enum ?? [],
    searchExample: successExample(search)
  };
}

export function validateReviewedOkfV02OpenApi(document, manifest) {
  const failures = [];
  const reviewedChangeIds = [
    "align-google-okf-v0-2-trust-signals",
    "add-general-purpose-graphrag-search",
    "validate-comprehensive-large-scale-release",
    "replace-upload-processing-with-document-indexing",
    "make-okf-bundle-path-linked-portable",
    "review-openapi-agent-continuity",
    "validate-cli-production-openapi-and-docs",
    "optimize-sparse-graphrag-hybrid-retrieval"
  ];
  if (JSON.stringify(manifest?.reviewedChangeIds) !== JSON.stringify(reviewedChangeIds)) {
    failures.push("The reviewed OpenAPI continuity change ID is invalid.");
  }
  if (sha256(document) !== manifest?.contractSha256) {
    failures.push("The Developer OpenAPI contract hash does not match the reviewed snapshot.");
  }
  if (sha256(reviewedOpenApiSurface(document)) !== manifest?.reviewedSurfaceSha256) {
    failures.push(
      "The Developer OpenAPI paths, parameters, response fields, errors, or examples do not match the reviewed surface."
    );
  }
  return { ok: failures.length === 0, failures };
}

export function sha256(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function collectOperations(document) {
  const result = [];
  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem ?? {})) {
      if (operation && typeof operation.operationId === "string") {
        result.push({ method: method.toUpperCase(), path, operationId: operation.operationId });
      }
    }
  }
  return result;
}

function propertyKeys(document, schemaName) {
  return Object.keys(document.components?.schemas?.[schemaName]?.properties ?? {});
}

function successExample(operation) {
  const status = Object.keys(operation?.responses ?? {})
    .find((value) => /^2\d\d$/u.test(value));
  return status
    ? operation.responses[status]?.content?.["application/json"]?.example
    : undefined;
}

function arraysEqual(left, right) {
  return left.length === right.length
    && left.every((item, index) => item === right[index]);
}
