#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";

const envPath = path.resolve(process.env.ENV_FILE || ".env");
if (fs.existsSync(envPath)) loadEnvFile(envPath);

const databaseUrl = requiredEnv("FOCOWIKI_COMPREHENSIVE_DATABASE_URL");
const providerBaseUrl = requiredEnv("FOCOWIKI_COMPREHENSIVE_PROVIDER_BASE_URL");
const providerApiKey = process.env.FOCOWIKI_COMPREHENSIVE_PROVIDER_API_KEY?.trim()
  || requiredEnv("MEILI_MASTER_KEY");
const indexPrefix = requiredEnv("FOCOWIKI_COMPREHENSIVE_SEARCH_INDEX_PREFIX");
const reportPath = path.resolve(requiredEnv(
  "FOCOWIKI_COMPREHENSIVE_MEILISEARCH_CLEANUP_REPORT"
));
const expectedKnowledgeBaseIds = requiredEnv(
  "FOCOWIKI_COMPREHENSIVE_KNOWLEDGE_BASE_IDS"
).split(",").map((value) => value.trim()).filter(Boolean);
const ownedTaskIndexPrefixes = (
  process.env.FOCOWIKI_COMPREHENSIVE_OWNED_TASK_PREFIXES?.trim()
    || indexPrefix
).split(",").map((value) => value.trim()).filter(Boolean);
const apiRequire = createRequire(path.join(process.cwd(), "apps/api/package.json"));
const postgres = apiRequire("postgres");
const sql = postgres(databaseUrl, {
  max: 2,
  connect_timeout: 10,
  idle_timeout: 5,
  prepare: false
});

try {
  assert(new Set(expectedKnowledgeBaseIds).size === 2,
    "Meilisearch cleanup requires exactly two expected knowledge bases");
  const before = await readOwnedState();
  assertSameSet(before.knowledgeBaseIds, expectedKnowledgeBaseIds,
    "Meilisearch cleanup active knowledge-base ownership changed");
  assert(before.currentSourceCount === 200,
    "Meilisearch cleanup requires the exact 200-source corpus");
  assert(before.activeWorkCount === 0,
    "Meilisearch cleanup requires all work to be idle");
  assert(before.retainedIndexes.length === 4,
    "Meilisearch cleanup requires exactly four retained indexes");

  const indexesBefore = await listOwnedIndexes();
  const retainedSet = new Set(before.retainedIndexes.map((item) => item.indexUid));
  for (const retained of retainedSet) {
    assert(indexesBefore.some((item) => item.uid === retained),
      "Meilisearch cleanup retained index is missing");
  }
  const staleDocuments = [];
  for (const retained of before.retainedIndexes.filter((item) => item.kind === "vector")) {
    const providerIds = await listDocumentIds(retained.indexUid);
    const expectedIds = new Set(retained.documentIds);
    const missing = retained.documentIds.filter((id) => !providerIds.has(id));
    assert(missing.length === 0,
      "Meilisearch cleanup cannot repair missing active vector documents");
    for (const id of providerIds) {
      if (!expectedIds.has(id)) {
        staleDocuments.push({ indexUid: retained.indexUid, documentId: id });
      }
    }
  }

  for (const [indexUid, ids] of groupByIndex(staleDocuments)) {
    await waitForTask(await requestTask(
      `/indexes/${encodeURIComponent(indexUid)}/documents/delete-batch`,
      { method: "POST", body: ids }
    ));
  }

  const orphanIndexes = indexesBefore
    .filter((item) => !retainedSet.has(item.uid))
    .sort((left, right) => left.uid.localeCompare(right.uid, "en"));
  for (const index of orphanIndexes) {
    await waitForTask(await requestTask(
      `/indexes/${encodeURIComponent(index.uid)}`,
      { method: "DELETE" }
    ));
  }

  const tasksBeforeDeletion = await listOwnedFinishedTasks();
  for (const taskUids of chunk(tasksBeforeDeletion.map((task) => task.uid), 200)) {
    if (taskUids.length === 0) continue;
    const task = await requestTask(
      `/tasks?uids=${taskUids.join(",")}`,
      { method: "DELETE" }
    );
    await waitForTask(task);
  }

  const after = await readOwnedState();
  const indexesAfter = await listOwnedIndexes();
  assertSameSet(
    indexesAfter.map((item) => item.uid),
    after.retainedIndexes.map((item) => item.indexUid),
    "Meilisearch cleanup retained index set did not converge"
  );
  const vectorChecks = [];
  for (const retained of after.retainedIndexes.filter((item) => item.kind === "vector")) {
    const providerIds = await listDocumentIds(retained.indexUid);
    assertSameSet([...providerIds], retained.documentIds,
      "Meilisearch cleanup vector identities did not converge");
    vectorChecks.push({
      indexUidSha256: sha256(retained.indexUid),
      expectedDocumentCount: retained.documentIds.length,
      providerDocumentCount: providerIds.size,
      pass: true
    });
  }
  const report = {
    format: "focowiki-comprehensive-meilisearch-cleanup-v1",
    generatedAt: new Date().toISOString(),
    ok: true,
    before: {
      ownedIndexCount: indexesBefore.length,
      retainedIndexCount: before.retainedIndexes.length,
      orphanIndexCount: orphanIndexes.length,
      staleActiveVectorDocumentCount: staleDocuments.length,
      finishedOwnedTaskCount: tasksBeforeDeletion.length
    },
    deleted: {
      orphanIndexes: orphanIndexes.map((item) => ({
        indexUidSha256: sha256(item.uid)
      })),
      staleActiveVectorDocuments: staleDocuments.map((item) => ({
        indexUidSha256: sha256(item.indexUid),
        documentIdSha256: sha256(item.documentId)
      })),
      finishedOwnedTaskCount: tasksBeforeDeletion.length
    },
    after: {
      ownedIndexCount: indexesAfter.length,
      retainedIndexCount: after.retainedIndexes.length,
      vectorChecks
    }
  };
  writePrivateReport(reportPath, report);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    reportPath,
    before: report.before,
    after: report.after
  })}\n`);
} finally {
  await sql.end({ timeout: 5 });
}

async function readOwnedState() {
  const snapshots = await sql`
    SELECT snapshot.knowledge_base_id,
           projection.provider_index_uid AS lexical_index_uid,
           projection.document_count AS lexical_document_count,
           generation.public_id AS semantic_generation_public_id,
           contract.mapping_fingerprint_sha256
    FROM focowiki.active_snapshots snapshot
    JOIN focowiki.search_projections projection
      ON projection.knowledge_base_id = snapshot.knowledge_base_id
     AND projection.public_id = snapshot.search_projection_public_id
     AND projection.projection_role = 'active'
     AND projection.state = 'ready'
    JOIN focowiki.semantic_generations generation
      ON generation.knowledge_base_id = snapshot.knowledge_base_id
     AND generation.generation_role = 'active'
     AND generation.state = 'active'
     AND generation.deleted_at IS NULL
    JOIN focowiki.semantic_projection_contracts contract
      ON contract.knowledge_base_id = generation.knowledge_base_id
     AND contract.semantic_generation_public_id = generation.public_id
    ORDER BY snapshot.knowledge_base_id COLLATE "C"
  `;
  const vectors = await sql`
    SELECT knowledge_base_id, semantic_generation_public_id,
           provider_document_id
    FROM focowiki.semantic_vector_documents
    WHERE state = 'active' AND deleted_at IS NULL
    ORDER BY knowledge_base_id COLLATE "C",
             semantic_generation_public_id COLLATE "C",
             provider_document_id COLLATE "C"
  `;
  const [{ source_count: sourceCount }] = await sql`
    SELECT count(*)::integer AS source_count
    FROM focowiki.source_files source
    JOIN focowiki.active_snapshots snapshot
      ON snapshot.knowledge_base_id = source.knowledge_base_id
    WHERE source.status = 'ready' AND source.deleted_at IS NULL
  `;
  const [{ active_work_count: activeWorkCount }] = await sql`
    SELECT (
      (SELECT count(*) FROM focowiki.operation_work_items
       WHERE state IN ('queued', 'running', 'retry'))
      +
      (SELECT count(*) FROM focowiki.semantic_stage_work_items
       WHERE state IN ('queued', 'running', 'retry'))
    )::integer AS active_work_count
  `;
  const retainedIndexes = snapshots.flatMap((snapshot) => [{
    kind: "lexical",
    indexUid: snapshot.lexical_index_uid,
    documentIds: [],
    documentCount: Number(snapshot.lexical_document_count)
  }, {
    kind: "vector",
    indexUid: semanticVectorIndexUid(snapshot),
    documentIds: vectors
      .filter((vector) => vector.knowledge_base_id === snapshot.knowledge_base_id
        && vector.semantic_generation_public_id
          === snapshot.semantic_generation_public_id)
      .map((vector) => vector.provider_document_id),
    documentCount: vectors.filter((vector) =>
      vector.knowledge_base_id === snapshot.knowledge_base_id
      && vector.semantic_generation_public_id
        === snapshot.semantic_generation_public_id).length
  }]);
  return {
    knowledgeBaseIds: snapshots.map((item) => item.knowledge_base_id),
    currentSourceCount: Number(sourceCount),
    activeWorkCount: Number(activeWorkCount),
    retainedIndexes
  };
}

async function listOwnedIndexes() {
  const response = await requestJson("/indexes?limit=1000");
  return (response.results ?? [])
    .filter((item) => isOwnedIndex(item.uid))
    .map((item) => ({ uid: item.uid, updatedAt: item.updatedAt }));
}

async function listDocumentIds(indexUid) {
  const ids = new Set();
  let offset = 0;
  while (true) {
    const page = await requestJson(
      `/indexes/${encodeURIComponent(indexUid)}`
        + `/documents?limit=500&offset=${offset}&fields=id`
    );
    const results = page.results ?? [];
    for (const document of results) {
      assert(typeof document.id === "string" && document.id,
        "Meilisearch cleanup encountered an invalid document identity");
      assert(!ids.has(document.id),
        "Meilisearch cleanup encountered a duplicate document identity");
      ids.add(document.id);
    }
    if (results.length < 500) break;
    offset += results.length;
  }
  return ids;
}

async function listOwnedFinishedTasks() {
  const tasks = [];
  let from = null;
  do {
    const url = new URL("/tasks", `${providerBaseUrl}/`);
    url.searchParams.set("limit", "1000");
    url.searchParams.set("statuses", "succeeded,failed,canceled");
    if (from !== null) url.searchParams.set("from", String(from));
    const page = await requestJson(`${url.pathname}${url.search}`);
    for (const task of page.results ?? []) {
      if (task.type === "taskDeletion" || task.indexUid
        && ownedTaskIndexPrefixes.some((prefix) => task.indexUid.startsWith(prefix))) {
        tasks.push({ uid: task.uid, type: task.type });
      }
    }
    from = page.next ?? null;
  } while (from !== null);
  return tasks;
}

async function requestTask(pathname, init) {
  const task = await requestJson(pathname, init);
  assert(Number.isSafeInteger(task.taskUid),
    "Meilisearch cleanup operation returned no task identity");
  return task.taskUid;
}

async function waitForTask(taskUid) {
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    const task = await requestJson(`/tasks/${taskUid}`);
    if (task.status === "succeeded") return;
    if (["failed", "canceled"].includes(task.status)) {
      throw new Error("Meilisearch cleanup task failed");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Meilisearch cleanup task timed out");
}

async function requestJson(pathname, init = {}) {
  const headers = {
    authorization: `Bearer ${providerApiKey}`,
    ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    ...(init.headers ?? {})
  };
  const response = await fetch(new URL(pathname, `${providerBaseUrl}/`), {
    ...init,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  });
  if (!response.ok) {
    throw new Error(`Meilisearch cleanup returned HTTP ${response.status}`);
  }
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

function groupByIndex(items) {
  const grouped = new Map();
  for (const item of items) {
    const ids = grouped.get(item.indexUid) ?? [];
    ids.push(item.documentId);
    grouped.set(item.indexUid, ids);
  }
  return [...grouped.entries()];
}

function semanticVectorIndexUid(input) {
  const digest = sha256([
    input.knowledge_base_id,
    input.semantic_generation_public_id,
    input.mapping_fingerprint_sha256
  ].join("\u001f")).slice(0, 48);
  return `${indexPrefix}-semantic-${digest}`;
}

function isOwnedIndex(indexUid) {
  return typeof indexUid === "string"
    && (indexUid.startsWith(`${indexPrefix}_`)
      || indexUid.startsWith(`${indexPrefix}-semantic-`));
}

function chunk(values, size) {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) =>
    values.slice(index * size, (index + 1) * size));
}

function assertSameSet(actual, expected, message) {
  const left = [...new Set(actual)].sort((a, b) => a.localeCompare(b, "en"));
  const right = [...new Set(expected)].sort((a, b) => a.localeCompare(b, "en"));
  assert(actual.length === left.length && expected.length === right.length
    && JSON.stringify(left) === JSON.stringify(right), message);
}

function writePrivateReport(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
