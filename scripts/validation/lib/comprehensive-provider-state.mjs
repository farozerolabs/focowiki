export function classifyComprehensiveCleanupIndexes(input) {
  const provider = requireString(input?.provider, "cleanup provider kind");
  if (!new Set(["opensearch", "meilisearch"]).has(provider)) {
    throw new Error("Comprehensive provider cleanup kind is invalid");
  }
  return requireArray(input?.rows, "cleanup index rows").map((item) => {
    const row = requireRecord(item, "cleanup index row");
    if (
      row.actionKind !== "provider_adoption"
      || row.cleanupPlane !== "search"
      || row.searchProviderKind !== provider
      || row.resourceKind !== "search_index"
      || !new Set(["queued", "running", "retry"]).has(row.state)
    ) throw new Error("Comprehensive provider cleanup ownership is invalid");
    const checkpoint = requireRecord(row.checkpoint, "cleanup index checkpoint");
    const indexUid = requireString(
      row.resourcePublicId,
      "cleanup index resource UID"
    );
    if (checkpoint.providerIndexUid !== indexUid) {
      throw new Error("Comprehensive provider cleanup index UID does not match");
    }
    return {
      indexUid,
      documentCount: requireNonnegativeInteger(
        checkpoint.documentCount,
        "cleanup index document count"
      )
    };
  }).sort((left, right) => left.indexUid.localeCompare(right.indexUid, "en"));
}

export function classifyComprehensiveQuarantinedIndexes(input) {
  const provider = requireString(input?.provider, "quarantined provider kind");
  if (!new Set(["opensearch", "meilisearch"]).has(provider)) {
    throw new Error("Comprehensive quarantined provider kind is invalid");
  }
  const now = Date.parse(requireString(input?.now, "quarantined current time"));
  if (!Number.isFinite(now)) {
    throw new Error("Comprehensive quarantined current time is invalid");
  }
  const retentionHours = input?.stagingRetentionHours;
  if (!Number.isSafeInteger(retentionHours)
    || retentionHours < 1 || retentionHours > 720) {
    throw new Error("Comprehensive quarantined retention is invalid");
  }
  const declaredIndexUids = uniqueStrings(
    input?.declaredIndexUids ?? [],
    "declared index UIDs"
  );
  const declared = new Set(declaredIndexUids);
  const cutoff = now - retentionHours * 60 * 60 * 1_000;
  return requireArray(input?.rows, "quarantined index rows").flatMap((item) => {
    const row = requireRecord(item, "quarantined index row");
    const indexUid = requireString(row.indexUid, "quarantined index UID");
    if (declared.has(indexUid)) return [];
    const updatedAt = requireString(row.updatedAt, "quarantined index update time");
    const updatedAtMilliseconds = Date.parse(updatedAt);
    if (!Number.isFinite(updatedAtMilliseconds)) {
      throw new Error("Comprehensive quarantined index update time is invalid");
    }
    if (updatedAtMilliseconds <= cutoff) {
      throw new Error(`Comprehensive provider index is overdue: ${indexUid}`);
    }
    return [{
      indexUid,
      documentCount: requireNonnegativeInteger(
        row.documentCount,
        "quarantined index document count"
      ),
      updatedAt: new Date(updatedAtMilliseconds).toISOString()
    }];
  }).sort((left, right) => left.indexUid.localeCompare(right.indexUid, "en"));
}

export function classifyComprehensiveRetainedLexicalIndexes(input) {
  const now = Date.parse(requireString(input?.now, "retained lexical current time"));
  if (!Number.isFinite(now)) {
    throw new Error("Comprehensive provider retained lexical current time is invalid");
  }
  const graceSeconds = input?.quarantineGracePeriodSeconds;
  if (!Number.isSafeInteger(graceSeconds) || graceSeconds < 1 || graceSeconds > 2_678_400) {
    throw new Error("Comprehensive provider retained lexical grace period is invalid");
  }
  const cutoff = now - graceSeconds * 1_000;
  return requireArray(input?.rows, "retained lexical rows").flatMap((item) => {
    const row = requireRecord(item, "retained lexical row");
    if (row.projectionRole !== "candidate" || row.state !== "failed") {
      throw new Error("Comprehensive provider retained lexical state is invalid");
    }
    const updatedAt = Date.parse(requireString(row.updatedAt, "retained lexical update time"));
    if (!Number.isFinite(updatedAt)) {
      throw new Error("Comprehensive provider retained lexical update time is invalid");
    }
    if (updatedAt <= cutoff) return [];
    return [{
      indexUid: requireString(row.indexUid, "retained lexical index UID"),
      documentCount: requireNonnegativeInteger(
        row.documentCount,
        "retained lexical document count"
      )
    }];
  }).sort((left, right) => left.indexUid.localeCompare(right.indexUid, "en"));
}

export function classifyComprehensiveRetainedSemanticIndexes(input) {
  return requireArray(input?.rows, "retained semantic rows").flatMap((item) => {
    const row = requireRecord(item, "retained semantic row");
    const documentCount = requireNonnegativeInteger(
      row.liveDocumentCount,
      "retained semantic live document count"
    );
    return documentCount === 0
      ? []
      : [{
          indexUid: requireString(row.indexUid, "retained semantic index UID"),
          documentCount
        }];
  }).sort((left, right) => left.indexUid.localeCompare(right.indexUid, "en"));
}

export function reconcileComprehensiveProviderCluster(input) {
  const provider = requireString(input?.provider, "provider kind");
  if (!new Set(["opensearch", "meilisearch"]).has(provider)) {
    throw new Error("Comprehensive provider cluster kind is invalid");
  }
  const expected = requireArray(input?.expectedIndexes, "expected indexes")
    .map((item) => {
      const record = requireRecord(item, "expected index");
      return {
        indexUid: requireString(record.indexUid, "expected index UID"),
        documentCount: requireNonnegativeInteger(
          record.documentCount,
          "expected index document count"
        )
      };
    });
  if (new Set(expected.map((item) => item.indexUid)).size !== expected.length) {
    throw new Error("Comprehensive provider expected index identities are duplicated");
  }
  const retained = requireArray(input?.retainedIndexes ?? [], "retained indexes")
    .map((item) => {
      const record = requireRecord(item, "retained index");
      return {
        indexUid: requireString(record.indexUid, "retained index UID"),
        documentCount: requireNonnegativeInteger(
          record.documentCount,
          "retained index document count"
        )
      };
    });
  const retainedIds = new Set(retained.map((item) => item.indexUid));
  const expectedIds = new Set(expected.map((item) => item.indexUid));
  if (retainedIds.size !== retained.length) {
    throw new Error("Comprehensive provider retained index identities are duplicated");
  }
  if ([...retainedIds].some((indexUid) => expectedIds.has(indexUid))) {
    throw new Error("Comprehensive provider active and retained index identities overlap");
  }
  const quarantined = requireArray(
    input?.quarantinedIndexes ?? [],
    "quarantined indexes"
  ).map((item) => {
    const record = requireRecord(item, "quarantined index");
    const updatedAt = requireString(record.updatedAt, "quarantined index update time");
    if (!Number.isFinite(Date.parse(updatedAt))) {
      throw new Error("Comprehensive provider quarantined index update time is invalid");
    }
    return {
      indexUid: requireString(record.indexUid, "quarantined index UID"),
      documentCount: requireNonnegativeInteger(
        record.documentCount,
        "quarantined index document count"
      ),
      updatedAt: new Date(updatedAt).toISOString()
    };
  });
  const quarantinedIds = new Set(quarantined.map((item) => item.indexUid));
  if (quarantinedIds.size !== quarantined.length) {
    throw new Error("Comprehensive provider quarantined index identities are duplicated");
  }
  if ([...quarantinedIds].some((indexUid) =>
    expectedIds.has(indexUid) || retainedIds.has(indexUid))) {
    throw new Error("Comprehensive provider quarantined index identities overlap");
  }
  const cluster = requireRecord(input?.cluster, "cluster state");
  const actual = provider === "opensearch"
    ? requireArray(cluster.indices, "OpenSearch indexes").map((item) => {
        const record = requireRecord(item, "OpenSearch index");
        if (record.status !== "open" || !["green", "yellow"].includes(record.health)) {
          throw new Error("Comprehensive provider OpenSearch index is not healthy and open");
        }
        return {
          indexUid: requireString(record.indexUid, "OpenSearch index UID"),
          documentCount: requireNonnegativeInteger(
            record.documentCount,
            "OpenSearch index document count"
          )
        };
      })
    : Object.entries(requireRecord(cluster.indexes, "Meilisearch indexes"))
      .map(([indexUid, item]) => {
        const record = requireRecord(item, "Meilisearch index");
        if (record.isIndexing !== false) {
          throw new Error("Comprehensive provider Meilisearch index is still indexing");
        }
        return {
          indexUid,
          documentCount: requireNonnegativeInteger(
            record.numberOfDocuments,
            "Meilisearch index document count"
          )
        };
      });
  if (new Set(actual.map((item) => item.indexUid)).size !== actual.length) {
    throw new Error("Comprehensive provider actual index identities are duplicated");
  }
  const actualIds = new Set(actual.map((item) => item.indexUid));
  if ([...expectedIds].some((indexUid) => !actualIds.has(indexUid))) {
    throw new Error("Comprehensive provider active index identities do not match");
  }
  if ([...actualIds].some((indexUid) =>
    !expectedIds.has(indexUid)
      && !retainedIds.has(indexUid)
      && !quarantinedIds.has(indexUid))) {
    throw new Error("Comprehensive provider cluster index identities do not match");
  }
  const actualById = new Map(actual.map((item) => [item.indexUid, item]));
  const indexes = expected
    .sort((left, right) => left.indexUid.localeCompare(right.indexUid, "en"))
    .map((item) => {
      const observed = actualById.get(item.indexUid);
      if (observed?.documentCount !== item.documentCount) {
        throw new Error(
          `Comprehensive provider cluster document count does not match: ${item.indexUid} expected=${item.documentCount} actual=${observed?.documentCount ?? "missing"}`
        );
      }
      return { ...item, pass: true };
    });
  const retainedIndexes = retained
    .filter((item) => actualIds.has(item.indexUid))
    .sort((left, right) => left.indexUid.localeCompare(right.indexUid, "en"))
    .map((item) => {
      const observed = actualById.get(item.indexUid);
      if (observed?.documentCount !== item.documentCount) {
        throw new Error(
          `Comprehensive provider retained document count does not match: ${item.indexUid} expected=${item.documentCount} actual=${observed?.documentCount ?? "missing"}`
        );
      }
      return { ...item, pass: true };
    });
  const quarantinedIndexes = quarantined
    .sort((left, right) => left.indexUid.localeCompare(right.indexUid, "en"))
    .map((item) => {
      const observed = actualById.get(item.indexUid);
      if (!observed || observed.documentCount !== item.documentCount) {
        throw new Error(
          `Comprehensive provider quarantined document count does not match: ${item.indexUid} expected=${item.documentCount} actual=${observed?.documentCount ?? "missing"}`
        );
      }
      return { ...item, pass: true };
    });
  const expectedAliases = requireArray(
    input?.expectedAliases ?? [],
    "expected aliases"
  ).map(normalizeAlias);
  const actualAliases = provider === "opensearch"
    ? requireArray(cluster.aliases, "OpenSearch aliases").map(normalizeAlias)
    : [];
  assertSetEquality(
    new Set(actualAliases.map(aliasIdentity)),
    new Set(expectedAliases.map(aliasIdentity)),
    "cluster alias identities"
  );
  const aliases = expectedAliases
    .sort((left, right) => aliasIdentity(left).localeCompare(aliasIdentity(right), "en"))
    .map((item) => ({ ...item, pass: true }));
  return {
    ok: true,
    provider,
    indexCount: indexes.length + retainedIndexes.length + quarantinedIndexes.length,
    activeIndexCount: indexes.length,
    retainedIndexCount: retainedIndexes.length,
    quarantinedIndexCount: quarantinedIndexes.length,
    aliasCount: aliases.length,
    indexes,
    retainedIndexes,
    quarantinedIndexes,
    aliases
  };
}

export function reconcileComprehensiveProviderState(input) {
  const knowledgeBases = requireArray(input?.knowledgeBases, "knowledge bases");
  const seenKnowledgeBases = new Set();
  const rows = knowledgeBases.map((knowledgeBase) => {
    const knowledgeBaseId = requireString(
      knowledgeBase?.knowledgeBaseId,
      "knowledge-base ID"
    );
    if (seenKnowledgeBases.has(knowledgeBaseId)) {
      throw new Error("Comprehensive provider state has duplicate knowledge-base ownership");
    }
    seenKnowledgeBases.add(knowledgeBaseId);
    const sourceFileIds = uniqueStrings(
      knowledgeBase?.sourceFileIds,
      "source file IDs"
    );
    const sourceSet = new Set(sourceFileIds);
    const lexical = requireRecord(knowledgeBase?.lexical, "lexical state");
    const lexicalDocuments = requireDocuments(lexical.documents, "lexical documents");
    if (lexicalDocuments.length !== lexical.expectedDocumentCount) {
      throw new Error("Comprehensive provider lexical document count does not match");
    }
    const lexicalIds = new Set();
    const lexicalSources = new Set();
    for (const document of lexicalDocuments) {
      const id = requireString(document.id, "lexical document ID");
      if (lexicalIds.has(id)) {
        throw new Error("Comprehensive provider lexical document identities are duplicated");
      }
      lexicalIds.add(id);
      if (document.knowledgeBaseId !== knowledgeBaseId) {
        throw new Error("Comprehensive provider lexical knowledge-base ownership is invalid");
      }
      const sourceFileId = requireString(
        document.sourceFileId,
        "lexical source file ID"
      );
      if (!sourceSet.has(sourceFileId)) {
        throw new Error("Comprehensive provider lexical source ownership is invalid");
      }
      if (document.visible !== undefined && document.visible !== true) {
        throw new Error("Comprehensive provider lexical document has a conflicting visibility flag");
      }
      lexicalSources.add(sourceFileId);
    }
    assertSetEquality(
      lexicalSources,
      sourceSet,
      "lexical source coverage"
    );

    const vector = requireRecord(knowledgeBase?.vector, "vector state");
    const expectedVectors = requireDocuments(
      vector.expectedDocuments,
      "expected vector documents"
    );
    const providerVectors = requireDocuments(
      vector.documents,
      "provider vector documents"
    );
    const expectedById = new Map(expectedVectors.map((document) => [
      requireString(document.id, "expected vector document ID"),
      document
    ]));
    if (expectedById.size !== expectedVectors.length) {
      throw new Error("Comprehensive provider expected vector identities are duplicated");
    }
    const providerById = new Map(providerVectors.map((document) => [
      requireString(document.id, "provider vector document ID"),
      document
    ]));
    if (providerById.size !== providerVectors.length) {
      throw new Error("Comprehensive provider vector document identities are duplicated");
    }
    assertSetEquality(
      new Set(providerById.keys()),
      new Set(expectedById.keys()),
      "vector document identities"
    );
    const vectorSources = new Set();
    const familyCounts = {};
    for (const [id, providerDocument] of providerById) {
      const expected = expectedById.get(id);
      if (providerDocument.knowledgeBaseId !== knowledgeBaseId) {
        throw new Error("Comprehensive provider vector knowledge-base ownership is invalid");
      }
      if (
        providerDocument.sourceFileId !== expected.sourceFileId
        || providerDocument.family !== expected.family
      ) {
        throw new Error("Comprehensive provider vector owner fields do not match");
      }
      if (!sourceSet.has(providerDocument.sourceFileId)) {
        throw new Error("Comprehensive provider vector source ownership is invalid");
      }
      if (expected.dimension !== vector.mappingDimension) {
        throw new Error("Comprehensive provider vector dimension does not match");
      }
      vectorSources.add(providerDocument.sourceFileId);
      familyCounts[providerDocument.family] = (familyCounts[providerDocument.family] ?? 0) + 1;
    }
    return {
      knowledgeBaseId,
      lexicalIndexUid: requireString(lexical.indexUid, "lexical index UID"),
      lexicalDocumentCount: lexicalDocuments.length,
      lexicalSourceCount: lexicalSources.size,
      vectorIndexUid: requireString(vector.indexUid, "vector index UID"),
      vectorDocumentCount: providerVectors.length,
      vectorSourceCount: vectorSources.size,
      vectorFamilyCounts: Object.fromEntries(
        Object.entries(familyCounts).sort(([left], [right]) => left.localeCompare(right, "en"))
      ),
      vectorDimension: vector.mappingDimension
    };
  });
  return { ok: true, knowledgeBases: rows };
}

function normalizeAlias(value) {
  const record = requireRecord(value, "provider alias");
  return {
    alias: requireString(record.alias, "provider alias name"),
    indexUid: requireString(record.indexUid, "provider alias index UID")
  };
}

function aliasIdentity(value) {
  return `${value.alias}\u001f${value.indexUid}`;
}

function requireNonnegativeInteger(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`Comprehensive provider ${field} is invalid`);
  }
  return number;
}

export function assertComprehensiveProviderSwitchReuse(input) {
  const before = requireRecord(input?.before, "provider-switch before state");
  const after = requireRecord(input?.after, "provider-switch after state");
  const fields = [
    "activeVectorDocumentCount",
    "completedModelSourceCount",
    "embeddingArtifactCount",
    "embeddingArtifactWatermark",
    "semanticGenerationCount",
    "semanticGenerationWatermark",
    "semanticReconciliationCount"
  ];
  for (const field of fields) {
    if (before[field] !== after[field]) {
      throw new Error(`Comprehensive provider switch repeated compatible work: ${field}`);
    }
  }
  return { ok: true, unchanged: [...fields].sort() };
}

export function createComprehensiveMaintenanceIdempotencyKey(input) {
  const provider = requireString(input?.provider, "provider");
  const knowledgeBaseId = requireString(
    input?.knowledgeBaseId,
    "knowledge-base ID"
  );
  const attempt = requireString(input?.attempt, "maintenance attempt");
  if (!/^[a-zA-Z0-9_-]{1,32}$/u.test(attempt)) {
    throw new Error("Comprehensive provider maintenance attempt is invalid");
  }
  return `comprehensive-switch:${provider}:${attempt}:${knowledgeBaseId}`;
}

export function extractComprehensiveMeilisearchVectorDimension(settings) {
  const record = requireRecord(settings, "Meilisearch settings");
  const embedders = requireRecord(record.embedders, "Meilisearch embedders");
  const entries = Object.values(embedders);
  if (entries.length !== 1) {
    throw new Error("Comprehensive provider Meilisearch embedder count is invalid");
  }
  const embedder = requireRecord(entries[0], "Meilisearch embedder");
  if (
    embedder.source !== "userProvided"
    || !Number.isSafeInteger(embedder.dimensions)
    || embedder.dimensions < 1
  ) {
    throw new Error("Comprehensive provider Meilisearch embedder is invalid");
  }
  return embedder.dimensions;
}

export function classifyComprehensiveMeilisearchTasks(input) {
  const indexPrefix = requireString(input?.indexPrefix, "Meilisearch index prefix");
  const ownedIndexPrefixes = uniqueStrings(
    input?.ownedIndexPrefixes ?? [indexPrefix],
    "Meilisearch owned index prefixes"
  );
  if (!ownedIndexPrefixes.includes(indexPrefix)) {
    throw new Error("Comprehensive provider active Meilisearch index prefix is unowned");
  }
  const tasks = requireArray(input?.tasks, "Meilisearch tasks");
  const seen = new Set();
  const items = tasks.map((task) => {
    const record = requireRecord(task, "Meilisearch task");
    const uid = record.uid;
    if (!Number.isSafeInteger(uid) || uid < 0 || seen.has(uid)) {
      throw new Error("Comprehensive provider Meilisearch task identity is invalid");
    }
    seen.add(uid);
    const status = requireString(record.status, "Meilisearch task status");
    const type = requireString(record.type, "Meilisearch task type");
    const indexUids = requireArray(
      record.indexUids ?? (record.indexUid ? [record.indexUid] : []),
      "Meilisearch task index UIDs"
    ).map((value) => requireString(value, "Meilisearch task index UID"));
    const errorCode = record.error === null || record.error === undefined
      ? null
      : requireString(
          requireRecord(record.error, "Meilisearch task error").code,
          "Meilisearch task error code"
        );
    const foreign = type !== "taskDeletion"
      && (indexUids.length === 0
        || indexUids.some((value) => !ownedIndexPrefixes.some(
          (prefix) => value.startsWith(prefix)
        )));
    let disposition;
    if (status === "succeeded") {
      disposition = type === "taskDeletion" ? "housekeeping" : "completed";
    } else if (status === "failed" && type === "indexCreation"
      && errorCode === "index_already_exists") {
      disposition = "recovered_idempotent";
    } else if (status === "enqueued" || status === "processing") {
      disposition = "in_progress";
    } else {
      disposition = "failed";
    }
    return {
      uid,
      status,
      type,
      indexUids,
      errorCode,
      foreign,
      disposition
    };
  });
  const counts = {
    total: items.length,
    completed: items.filter((item) => item.disposition === "completed").length,
    recoveredIdempotent: items.filter(
      (item) => item.disposition === "recovered_idempotent"
    ).length,
    housekeeping: items.filter((item) => item.disposition === "housekeeping").length,
    inProgress: items.filter((item) => item.disposition === "in_progress").length,
    failed: items.filter((item) => item.disposition === "failed").length,
    foreign: items.filter((item) => item.foreign).length
  };
  return {
    ok: counts.inProgress === 0 && counts.failed === 0 && counts.foreign === 0,
    counts,
    items
  };
}

export function reconcileComprehensiveMeilisearchPhase(input) {
  const search = requireRecord(input?.search, "Meilisearch search ledger");
  const searchCounts = requireRecord(search.counts, "Meilisearch search counts");
  if (search.ok !== true || search.provider !== "meilisearch"
    || searchCounts.expectedFiles !== 200 || searchCounts.completedFiles !== 200
    || searchCounts.expectedQueries !== searchCounts.completedQueries
    || searchCounts.completedQueries !== searchCounts.successfulQueries
    || searchCounts.sourceReads < 400 || searchCounts.failures !== 0
    || searchCounts.expectedFilterDispositions
      !== searchCounts.completedFilterDispositions) {
    throw new Error("Comprehensive provider Meilisearch search ledger is incomplete");
  }

  const state = requireRecord(input?.providerState, "Meilisearch provider state");
  const knowledgeBases = requireArray(
    state.knowledgeBases,
    "Meilisearch provider knowledge bases"
  );
  if (state.ok !== true || state.provider !== "meilisearch" || knowledgeBases.length < 1) {
    throw new Error("Comprehensive provider Meilisearch state is incomplete");
  }
  let lexicalDocuments = 0;
  let vectorDocuments = 0;
  let mappingFields = 0;
  for (const knowledgeBase of knowledgeBases) {
    const record = requireRecord(knowledgeBase, "Meilisearch provider knowledge base");
    const lexical = requireRecord(record.lexical, "Meilisearch lexical state");
    const vector = requireRecord(record.vector, "Meilisearch vector state");
    const evidence = requireRecord(
      record.providerEvidence,
      "Meilisearch provider evidence"
    );
    const lexicalFields = requireArray(
      requireRecord(evidence.lexical, "Meilisearch lexical evidence").mappingFields,
      "Meilisearch lexical mapping fields"
    );
    const vectorFields = requireArray(
      requireRecord(evidence.vector, "Meilisearch vector evidence").mappingFields,
      "Meilisearch vector mapping fields"
    );
    if (lexicalFields.length === 0 || vectorFields.length === 0) {
      throw new Error("Comprehensive provider Meilisearch mapping field ledger is incomplete");
    }
    lexicalDocuments += requireArray(
      lexical.documents,
      "Meilisearch lexical documents"
    ).length;
    vectorDocuments += requireArray(
      vector.documents,
      "Meilisearch vector documents"
    ).length;
    mappingFields += lexicalFields.length + vectorFields.length;
  }
  const providerTasks = requireRecord(state.tasks, "Meilisearch provider tasks");
  const cluster = requireRecord(state.cluster, "Meilisearch cluster state");
  const clusterReconciliation = requireRecord(
    state.clusterReconciliation,
    "Meilisearch cluster reconciliation"
  );
  const retainedIndexCount = requireNonnegativeInteger(
    clusterReconciliation.retainedIndexCount,
    "Meilisearch retained index count"
  );
  const quarantinedIndexCount = requireNonnegativeInteger(
    clusterReconciliation.quarantinedIndexCount ?? 0,
    "Meilisearch quarantined index count"
  );
  if (providerTasks.activeWriteTaskCount !== 0
    || clusterReconciliation.ok !== true
    || clusterReconciliation.activeIndexCount !== knowledgeBases.length * 2
    || clusterReconciliation.indexCount !== cluster.indexCount
    || retainedIndexCount + quarantinedIndexCount
      !== cluster.indexCount - clusterReconciliation.activeIndexCount) {
    throw new Error("Comprehensive provider Meilisearch active state is not converged");
  }

  const oracle = requireRecord(input?.vectorOracle, "Meilisearch vector oracle");
  const oracleCounts = requireRecord(oracle.counts, "Meilisearch vector oracle counts");
  const oracleSummary = requireRecord(
    oracle.querySummary,
    "Meilisearch vector oracle summary"
  );
  const annRecall = requireRecord(
    oracleSummary.annRecall,
    "Meilisearch ANN recall"
  );
  if (oracle.ok !== true || oracle.provider !== "meilisearch"
    || oracleCounts.vectorArtifacts !== vectorDocuments
    || oracleCounts.vectorQueries !== oracleCounts.successfulVectorQueries
    || oracleCounts.failedVectorQueries !== 0
    || oracleCounts.hydratedSources !== oracleCounts.vectorQueries
    || annRecall.minimum !== 1) {
    throw new Error("Comprehensive provider Meilisearch vector oracle is incomplete");
  }

  const taskLedger = requireRecord(input?.taskLedger, "Meilisearch task ledger");
  const taskCounts = requireRecord(taskLedger.counts, "Meilisearch task counts");
  const taskItems = requireArray(taskLedger.items, "Meilisearch task items");
  if (taskLedger.ok !== true || taskLedger.expectedTotal !== taskItems.length
    || taskCounts.total !== taskItems.length || taskCounts.inProgress !== 0
    || taskCounts.failed !== 0 || taskCounts.foreign !== 0) {
    throw new Error("Comprehensive provider Meilisearch task ledger is incomplete");
  }

  const switchReport = requireRecord(
    input?.switchReport,
    "Meilisearch provider switch report"
  );
  if (switchReport.ok !== true
    || requireRecord(switchReport.reuse, "Meilisearch provider reuse").ok !== true) {
    throw new Error("Comprehensive provider Meilisearch reuse evidence is incomplete");
  }

  return {
    ok: true,
    files: searchCounts.completedFiles,
    queries: searchCounts.completedQueries,
    sourceReads: searchCounts.sourceReads,
    filterDispositions: searchCounts.completedFilterDispositions,
    lexicalDocuments,
    vectorDocuments,
    mappingFields,
    providerTasks: taskItems.length,
    vectorArtifacts: oracleCounts.vectorArtifacts,
    vectorQueryFamilies: oracleCounts.vectorQueries,
    vectorHydrations: oracleCounts.hydratedSources,
    minimumAnnRecall: annRecall.minimum,
    activeWriteTasks: providerTasks.activeWriteTaskCount,
    repeatedCompatibleModelWork: false
  };
}

function assertSetEquality(actual, expected, field) {
  const missing = [...expected].filter((value) => !actual.has(value)).length;
  const extra = [...actual].filter((value) => !expected.has(value)).length;
  if (missing > 0 || extra > 0) {
    throw new Error(
      `Comprehensive provider ${field} do not match `
      + `(actual=${actual.size} expected=${expected.size} missing=${missing} extra=${extra})`
    );
  }
}

function uniqueStrings(value, field) {
  const values = requireArray(value, field).map((item) => requireString(item, field));
  if (new Set(values).size !== values.length) {
    throw new Error(`Comprehensive provider ${field} are duplicated`);
  }
  return values;
}

function requireDocuments(value, field) {
  return requireArray(value, field).map((document) => requireRecord(document, field));
}

function requireArray(value, field) {
  if (!Array.isArray(value)) throw new Error(`Comprehensive provider ${field} are invalid`);
  return value;
}

function requireRecord(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Comprehensive provider ${field} is invalid`);
  }
  return value;
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Comprehensive provider ${field} is invalid`);
  }
  return value;
}
