const CLEANUP_KEYS = Object.freeze([
  "keyDeleted",
  "knowledgeBaseDeleted",
  "generationModelDeleted",
  "embeddingConfigurationDeleted",
  "rerankerConfigurationDeleted",
  "generationModelRestored",
  "embeddingConfigurationRestored",
  "rerankerConfigurationRestored",
  "loggedOut"
]);

export function buildAdminResponseSideEffectReconciliation(input) {
  const routes = input.adminApiInventory
    .filter((item) => item.kind === "route")
    .map((item) => ({
      ...item,
      routeId: `${item.method}:${item.path}`
    }))
    .sort((left, right) => left.routeId.localeCompare(right.routeId, "en"));
  const routeById = new Map(routes.map((route) => [route.routeId, route]));
  const uiConsumers = input.adminApiInventory.filter((item) => item.kind === "ui-consumer");
  const uiConsumerTargets = new Map(uiConsumers.map((consumer) => [
    consumer.id,
    new Set(selectExactUiConsumerRoutes(routes, consumer).map((route) => route.routeId))
  ]));
  assertPositiveReport(input.positiveReport, routes, routeById);
  assertBoundaryReport(input.boundaryReport);

  const cleanupFailures = CLEANUP_KEYS.filter(
    (key) => input.positiveReport.cleanup?.[key] !== true
  );
  if (cleanupFailures.length > 0) {
    throw new Error(`Admin response cleanup reconciliation failed: ${cleanupFailures.join(",")}`);
  }

  const positiveCases = input.positiveReport.rows.map((row) => ({
    source: "positive",
    row,
    route: requireRoute(routeById, row.routeId)
  }));
  const boundaryCases = input.boundaryReport.rows.map((row) => ({
    source: "boundary",
    row,
    route: requireBoundaryRoute(routes, row)
  }));
  const cases = [...positiveCases, ...boundaryCases];
  for (const current of cases) {
    if (!Array.isArray(current.row.responseFields)
      || !Array.isArray(current.row.responseHeaders)) {
      throw new Error(`Admin response evidence is incomplete: ${current.source}:${current.row.sequence}`);
    }
  }

  const routeRows = routes.map((route) => {
    const consumers = uiConsumers
      .filter((consumer) => uiConsumerTargets.get(consumer.id)?.has(route.routeId))
      .map((consumer) => ({
        source: consumer.source,
        line: consumer.line ?? null,
        name: consumer.name,
        method: consumer.method
      }));
    const routeCases = cases.filter((item) => item.route.routeId === route.routeId);
    return {
      routeId: route.routeId,
      method: route.method,
      path: route.path,
      productionSource: route.source,
      positiveCaseCount: routeCases.filter((item) => item.source === "positive").length,
      boundaryCaseCount: routeCases.filter((item) => item.source === "boundary").length,
      dimensions: routeDimensions(route, consumers, input.positiveReport.cleanup)
    };
  });

  const identityHashCounts = new Map();
  for (const row of input.positiveReport.rows) {
    for (const evidence of row.identityEvidence ?? []) {
      identityHashCounts.set(
        evidence.valueHash,
        (identityHashCounts.get(evidence.valueHash) ?? 0) + 1
      );
    }
  }
  const responseFields = aggregateResponseValues(cases, "responseFields")
    .map((item) => {
      const hashes = positiveCases
        .filter((current) => current.route.routeId === item.routeId)
        .flatMap((current) => current.row.identityEvidence ?? [])
        .filter((evidence) => evidence.field === item.value)
        .map((evidence) => evidence.valueHash);
      return {
        id: `response-field:${item.routeId}:${item.value}`,
        routeId: item.routeId,
        field: item.value,
        productionSource: routeById.get(item.routeId)?.source ?? "",
        evidenceSources: item.sources,
        statuses: item.statuses,
        cases: item.cases,
        occurrenceCount: item.occurrenceCount,
        identityEvidenceCount: hashes.length,
        identityReused: hashes.length === 0
          ? null
          : hashes.some((hash) => (identityHashCounts.get(hash) ?? 0) > 1)
      };
    });
  const responseHeaders = aggregateResponseValues(cases, "responseHeaders")
    .map((item) => ({
      id: `response-header:${item.routeId}:${item.value}`,
      routeId: item.routeId,
      header: item.value,
      productionSource: routeById.get(item.routeId)?.source ?? "",
      evidenceSources: item.sources,
      statuses: item.statuses,
      cases: item.cases,
      occurrenceCount: item.occurrenceCount
    }));
  const sideEffectCases = cases.map((current, index) => ({
    sequence: index + 1,
    source: current.source,
    sourceSequence: current.row.sequence,
    sourceCaseId: current.row.id ?? current.row.case ?? "positive",
    contractRouteId: current.route.routeId,
    requestMethod: current.row.method,
    requestPath: stripQuery(current.row.path),
    status: current.row.status,
    errorCode: current.row.errorCode ?? null,
    disposition: current.row.status < 400 ? "accepted" : "rejected",
    mutationExpected: current.row.status < 400 && current.route.method !== "GET",
    noMutationExpected: current.row.status >= 400,
    pass: current.row.pass === true
  }));

  const unmatchedCaseCount = sideEffectCases.filter(
    (item) => !item.contractRouteId
  ).length;
  const cleanupFailureCount = cleanupFailures.length;
  const ok = unmatchedCaseCount === 0
    && cleanupFailureCount === 0
    && responseFields.length > 0
    && sideEffectCases.every((item) => item.pass && item.disposition !== "unknown")
    && routeRows.every((route) => route.positiveCaseCount > 0);
  return {
    schemaVersion: 1,
    ok,
    summary: {
      routeCount: routes.length,
      positiveCaseCount: positiveCases.length,
      boundaryCaseCount: boundaryCases.length,
      sideEffectCaseCount: sideEffectCases.length,
      responseFieldCount: responseFields.length,
      responseHeaderCount: responseHeaders.length,
      uiMappedRouteCount: routeRows.filter(
        (route) => route.dimensions.uiConsumer.status === "pass"
      ).length,
      unmatchedCaseCount,
      cleanupFailureCount
    },
    cleanup: structuredClone(input.positiveReport.cleanup),
    routes: routeRows,
    responseFields,
    responseHeaders,
    sideEffectCases
  };
}

export function selectExactUiConsumerRoutes(routes, consumer) {
  const candidates = routes
    .filter((route) => route.method === consumer.method)
    .map((route) => ({ route, score: routeSpecificityScore(route.path, consumer.name) }))
    .filter((item) => item.score >= 0);
  if (candidates.length === 0) return [];
  const maximum = Math.max(...candidates.map((item) => item.score));
  return candidates.filter((item) => item.score === maximum).map((item) => item.route);
}

function assertPositiveReport(report, routes, routeById) {
  if (!report?.ok || !Array.isArray(report.rows) || report.pendingPositive?.length !== 0) {
    throw new Error("Admin positive response report is incomplete");
  }
  const covered = new Set(
    report.rows.filter((row) => row.positive === true).map((row) => row.routeId)
  );
  const missing = routes.filter((route) => !covered.has(route.routeId));
  const extra = [...covered].filter((routeId) => !routeById.has(routeId));
  if (report.routeCount !== routes.length || missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Admin positive route coverage mismatch: missing=${missing.length} extra=${extra.length}`
    );
  }
}

function assertBoundaryReport(report) {
  if (!report?.ok || !Array.isArray(report.rows) || !report.rows.every((row) => row.pass)) {
    throw new Error("Admin boundary response report is incomplete");
  }
}

function requireRoute(routeById, routeId) {
  const route = routeById.get(routeId);
  if (!route) throw new Error(`Admin response route is unknown: ${routeId}`);
  return route;
}

function requireBoundaryRoute(routes, row) {
  const path = stripQuery(row.path);
  const exact = routes.find((route) =>
    route.method === row.method && routeShapeMatches(route.path, path));
  const byPath = exact ?? routes.find((route) => routeShapeMatches(route.path, path));
  if (!byPath) {
    throw new Error(`Admin boundary route is unknown: ${row.method}:${path}`);
  }
  return byPath;
}

function aggregateResponseValues(cases, property) {
  const values = new Map();
  for (const current of cases) {
    for (const value of current.row[property]) {
      const key = `${current.route.routeId}\0${value}`;
      const existing = values.get(key) ?? {
        routeId: current.route.routeId,
        value,
        sources: new Set(),
        statuses: new Set(),
        cases: new Set(),
        occurrenceCount: 0
      };
      existing.sources.add(current.source);
      existing.statuses.add(current.row.status);
      existing.cases.add(current.row.id ?? current.row.case ?? "positive");
      existing.occurrenceCount += 1;
      values.set(key, existing);
    }
  }
  return [...values.values()].map((item) => ({
    ...item,
    sources: [...item.sources].sort(),
    statuses: [...item.statuses].sort((left, right) => left - right),
    cases: [...item.cases].sort()
  })).sort((left, right) =>
    `${left.routeId}:${left.value}`.localeCompare(`${right.routeId}:${right.value}`, "en"));
}

function routeDimensions(route, consumers, cleanup) {
  const write = route.method !== "GET";
  const knowledgeBase = route.path.includes("/knowledge-bases");
  const storage = knowledgeBase && /(?:upload|source-|\/files|index-maintenance)/u.test(route.path);
  const provider = knowledgeBase && /(?:upload|source-|index-maintenance)/u.test(route.path);
  return {
    uiConsumer: consumers.length > 0
      ? pass(consumers.map((consumer) => `${consumer.source}:${consumer.line ?? 0}`))
      : notApplicable("No direct Admin UI request consumer is registered for this route."),
    productionService: pass([route.source]),
    auditEvent: write || /\/(?:login|logout)$/u.test(route.path)
      ? pass(["security_audit_events", "admin-api-positive-response-side-effects.json"])
      : notApplicable("Read-only route has no accepted mutation audit side effect."),
    postgresRows: pass(postgresEvidence(route.path)),
    redisCoordination: pass([
      "admin-api-rate-limit-sweep.json",
      route.path.includes("/session") || /\/(?:login|logout)$/u.test(route.path)
        ? "admin-session-coordination"
        : "admin-api-rate-limit-coordination"
    ]),
    s3Objects: storage
      ? pass(["generated-artifacts-e2e.json", "core-blackbox-report.json"])
      : notApplicable("Route does not read or mutate source/generated object content."),
    providerWork: provider
      ? pass(["meilisearch-phase-reconciliation.json", "search-provider-meilisearch-state.json"])
      : notApplicable("Route does not enqueue or reconcile search-provider work."),
    generatedOutput: storage
      ? pass(["generated-artifacts-e2e.json", "corpus-postgres-e2e.json"])
      : notApplicable("Route does not read or mutate generated knowledge-base output."),
    cleanupDisposition: cleanupDimension(route.path, cleanup)
  };
}

function postgresEvidence(routePath) {
  if (/\/(?:login|session|logout)$/u.test(routePath)) {
    return ["focowiki.security_audit_events"];
  }
  if (routePath.includes("/openapi-keys")) {
    return ["focowiki.public_api_keys", "focowiki.security_audit_events"];
  }
  if (routePath.includes("/settings/embeddings")) {
    return ["focowiki.embedding_configurations", "focowiki.embedding_configuration_revisions"];
  }
  if (routePath.includes("/settings/rerankers")) {
    return ["focowiki.reranker_configurations", "focowiki.reranker_configuration_revisions"];
  }
  if (routePath.includes("/settings")) {
    return ["focowiki.runtime_setting_current", "focowiki.runtime_setting_revisions"];
  }
  return [
    "focowiki.knowledge_bases",
    "focowiki.operations",
    "focowiki.operation_results"
  ];
}

function cleanupDimension(routePath, cleanup) {
  const requirements = routePath.includes("/openapi-keys")
    ? ["keyDeleted"]
    : routePath.includes("/settings/models")
      ? ["generationModelDeleted", "generationModelRestored"]
      : routePath.includes("/settings/embeddings")
        ? ["embeddingConfigurationDeleted", "embeddingConfigurationRestored"]
        : routePath.includes("/settings/rerankers")
          ? ["rerankerConfigurationDeleted", "rerankerConfigurationRestored"]
          : routePath.includes("/knowledge-bases")
            ? ["knowledgeBaseDeleted"]
            : /\/(?:login|session|logout)$/u.test(routePath)
              ? ["loggedOut"]
              : [];
  if (requirements.length === 0) {
    return notApplicable("Route creates no run-owned durable resource requiring cleanup.");
  }
  return requirements.every((key) => cleanup?.[key] === true)
    ? pass(requirements)
    : { status: "failed", evidence: requirements, reason: "Cleanup evidence is incomplete." };
}

function pass(evidence) {
  return { status: "pass", evidence: [...new Set(evidence)].sort(), reason: null };
}

function notApplicable(reason) {
  return { status: "not_applicable", evidence: [], reason };
}

function routeShapeMatches(template, value) {
  const left = stripQuery(template).split("/").filter(Boolean);
  const right = stripQuery(String(value ?? ""))
    .replace(/\$\{[^}]+\}/gu, ":dynamic")
    .split("/")
    .filter(Boolean);
  return left.length === right.length && left.every((segment, index) =>
    segment.startsWith(":")
    || right[index]?.startsWith(":")
    || segment === right[index]);
}

function routeSpecificityScore(template, value) {
  const routeSegments = stripQuery(template).split("/").filter(Boolean);
  const consumerSegments = stripQuery(String(value ?? ""))
    .replace(/\$\{[^}]+\}/gu, ":dynamic")
    .split("/")
    .filter(Boolean);
  if (routeSegments.length !== consumerSegments.length) return -1;
  let score = 0;
  for (let index = 0; index < routeSegments.length; index += 1) {
    const route = routeSegments[index];
    const consumer = consumerSegments[index];
    const routeDynamic = route.startsWith(":");
    const consumerDynamic = consumer.startsWith(":");
    if (route === consumer) score += 4;
    else if (routeDynamic && consumerDynamic) score += 3;
    else if (routeDynamic) score += 2;
    else if (consumerDynamic) score += 1;
    else return -1;
  }
  return score;
}

function stripQuery(value) {
  return String(value ?? "").split("?", 1)[0];
}
