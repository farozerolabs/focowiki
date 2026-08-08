import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import path from "node:path";

import { OKF_V02_RUNTIME_VARIANTS, buildOkfV02ValidMarkdown } from
  "./okf-v02-runtime-cases.mjs";
import { createOpenApiRuntimeResponseValidator } from
  "./openapi-runtime-response-validator.mjs";
import { recordOkfV02OwnedResource } from "./okf-v02-workspace.mjs";
import {
  findUnexpectedOkfV02RejectedGeneratedPaths,
  inspectOkfV02RepresentativePages
} from
  "./okf-v02-corpus-inspection.mjs";
import {
  createOkfV02ResourceSampler,
  summarizeOkfV02NoopPublication
} from "./okf-v02-runtime-observations.mjs";

const TOKEN = "okfv02e2etoken";
const POLL_INTERVAL_MS = 500;
const OPERATION_TIMEOUT_MS = 10 * 60_000;

export async function createOkfV02HttpE2E(input) {
  const admin = createHttpClient({
    baseUrl: `http://127.0.0.1:${input.env.ADMIN_API_PORT || "43000"}`
  });
  const responseValidator = createOpenApiRuntimeResponseValidator(input.openApiDocument);
  const developer = createHttpClient({
    baseUrl: `http://127.0.0.1:${input.env.PUBLIC_OPENAPI_PORT || "43200"}`,
    responseValidator
  });
  const origin = input.env.ADMIN_PUBLIC_ORIGIN || "http://127.0.0.1:43100";
  const ownership = resolveOkfV02RunOwnership(input);
  let keyId = null;
  let originalPublication = null;
  let originalWorker = null;

  await login();
  const settings = await admin.json("/admin/api/settings/runtime");
  originalPublication = settings.settings.publication;
  originalWorker = settings.settings.worker;
  await updateRuntimeSettings({
    publication: { ...originalPublication, mode: "batch", intervalSeconds: 5 },
    worker: {
      ...originalWorker,
      jobRetryDelayMs: 100,
      hardDeleteRetryDelayMs: 100
    }
  });
  const credential = await admin.json("/admin/api/openapi-keys", {
    method: "POST",
    headers: { origin },
    json: { name: `OKF v0.2 E2E ${input.runId}` },
    expectedStatus: 201
  });
  keyId = credential.key.id;
  developer.authorization = `Bearer ${credential.oneTimeKey.rawKey}`;
  recordOkfV02OwnedResource(ownership, "openApiKeyIds", keyId);
  recordOkfV02OwnedResource(ownership, "knowledgeBaseIds", input.knowledgeBaseId);
  await input.journal.update({ ownership });

  return {
    async runInitialProviderChecks() {
      await validateRejectedOfficialAssets(input.official);
      assertCorpusBaseline(input.lifecycle?.okfV02Baseline);
      const sourceFiles = await listAll(
        developer,
        `${knowledgeBaseRoute()}/source-files?limit=200`
      );
      const mutable = sourceFiles.filter((file) =>
        file.state === "visible" && file.relativePath.startsWith("legacy/")).slice(0, 4);
      assert(mutable.length >= 4, "The 200-file E2E did not retain enough mutable files.");

      const primary = mutable[0];
      await replaceAndVerify(primary.sourceFileId, buildOkfV02ValidMarkdown("initial-valid"), {
        expectedRaw: {
          okf_version: "0.2",
          status: "stable",
          stale_after: "2027-12-31"
        },
        expectedSignals: {
          effectiveStatus: "stable",
          trustTier: "human-reviewed",
          isStale: false,
          sourceCount: 1
        }
      });
      for (const variant of OKF_V02_RUNTIME_VARIANTS) {
        await replaceAndVerify(primary.sourceFileId, variant.markdown, variant);
      }
      const restored = await replaceAndVerify(
        primary.sourceFileId,
        buildOkfV02ValidMarkdown("restored-valid"),
        {
          expectedRaw: { status: "stable", stale_after: "2027-12-31" },
          expectedSignals: {
            effectiveStatus: "stable",
            trustTier: "human-reviewed",
            isStale: false,
            sourceCount: 1
          }
        }
      );
      const nullable = await replaceAndVerify(
        mutable[1].sourceFileId,
        OKF_V02_RUNTIME_VARIANTS.find((variant) => variant.id === "status-wrong-type").markdown,
        OKF_V02_RUNTIME_VARIANTS.find((variant) => variant.id === "status-wrong-type")
      );
      const incompleteVariant = OKF_V02_RUNTIME_VARIANTS.find(
        (variant) => variant.id === "executor-wrong-type"
      );
      const incomplete = await replaceAndVerify(
        mutable[2].sourceFileId,
        incompleteVariant.markdown,
        incompleteVariant
      );
      const inspectionTargets = {
        validPath: restored.file.path,
        malformedPath: nullable.file.path,
        incompleteAttestedPath: incomplete.file.path
      };
      const artifacts = await inspectGeneratedArtifacts(inspectionTargets);
      const search = await runSearchMatrix({
        stableFileId: restored.file.fileId,
        nullableFileId: nullable.file.fileId
      });
      const noOpPublication = await runNoopPublicationCheck(
        inspectionTargets,
        mutable[3].sourceFileId
      );
      await recordRunOperations();
      await input.journal.update({
        phase: "initial-provider-verified",
        ownership,
        providerEvidence: {
          initial: input.provider,
          search,
          artifacts,
          noOpPublication
        }
      });
      return {
        stableFileId: restored.file.fileId,
        nullableFileId: nullable.file.fileId,
        search,
        inspectionTargets,
        noOpPublication
      };
    },

    async runSwitchedProviderChecks(initial) {
      const unavailable = await developer.json(
        searchPath({ query: TOKEN, limit: 20 }),
        { expectedStatus: 503 }
      );
      assert(
        unavailable.error?.code === "SEARCH_UNAVAILABLE",
        "Provider switch did not expose the documented maintenance search error."
      );
      const before = await processingSummary();
      assert(
        before.indexMaintenance?.maintenanceRequired === true,
        "Provider switch did not require explicit index maintenance."
      );
      const requested = await admin.json(
        `/admin/api/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}/index-maintenance`,
        {
          method: "POST",
          headers: { origin, "idempotency-key": `${input.runId}-provider-adoption` },
          json: {},
          expectedStatus: 202
        }
      );
      if (requested.maintenance?.requestId) {
        recordOkfV02OwnedResource(
          ownership,
          "operationIds",
          requested.maintenance.requestId
        );
      }
      await waitForIndexMaintenance();
      const search = await runSearchMatrix({
        stableFileId: initial.stableFileId,
        nullableFileId: initial.nullableFileId
      });
      assert.deepEqual(
        search.unfilteredFileIds,
        initial.search.unfilteredFileIds,
        "Search providers returned different file identities."
      );
      await inspectGeneratedArtifacts(initial.inspectionTargets);
      await input.journal.update({
        phase: "second-provider-verified",
        ownership,
        providerEvidence: {
          initial: input.provider,
          second: input.secondProvider,
          search
        }
      });
      return search;
    },

    async cleanup() {
      try {
        if (developer.authorization) {
          const current = await developer.json(knowledgeBaseRoute(), {
            expectedStatus: [200, 404]
          });
          if (current?.knowledgeBase) {
            const deleted = await developer.json(knowledgeBaseRoute(), {
              method: "DELETE",
              headers: {
                "if-match": `"${current.knowledgeBase.resourceRevision}"`,
                "idempotency-key": `${input.runId}-cleanup-kb`
              },
              expectedStatus: 202
            });
            if (deleted.operation?.operationId) {
              recordOkfV02OwnedResource(
                ownership,
                "operationIds",
                deleted.operation.operationId
              );
            }
            await waitUntilMissing(knowledgeBaseRoute());
          }
        }
      } finally {
        if (keyId) {
          await admin.request(`/admin/api/openapi-keys/${encodeURIComponent(keyId)}`, {
            method: "DELETE",
            headers: { origin }
          }).catch(() => undefined);
          keyId = null;
        }
        if (originalPublication && originalWorker) {
          await updateRuntimeSettings({
            publication: originalPublication,
            worker: originalWorker
          }).catch(() => undefined);
        }
        await admin.request("/admin/api/logout", {
          method: "POST",
          headers: { origin }
        }).catch(() => undefined);
        await input.journal.update({ ownership });
      }
    }
  };

  async function login() {
    await admin.json("/admin/api/login", {
      method: "POST",
      headers: { origin },
      json: {
        username: required(input.env, "ADMIN_USERNAME"),
        password: required(input.env, "ADMIN_PASSWORD")
      }
    });
  }

  async function updateRuntimeSettings(settings) {
    await admin.json("/admin/api/settings/publication", {
      method: "PUT",
      headers: { origin },
      json: settings.publication
    });
    await admin.json("/admin/api/settings/worker", {
      method: "PUT",
      headers: { origin },
      json: settings.worker
    });
  }

  async function validateRejectedOfficialAssets(official) {
    for (const entry of official.reserved) {
      await rejectUploadPath(entry.relativePath, entry.sizeBytes, "reserved");
    }
    for (const entry of official.nonMarkdown) {
      await rejectUploadPath(entry.relativePath, entry.sizeBytes, "extension");
    }
    const representative = official.nonMarkdown[0];
    if (representative) {
      const rejectedRead = await developer.json(
        `${knowledgeBaseRoute()}/files/content?path=${encodeURIComponent(
          `pages/official/${representative.relativePath}`
        )}`,
        { expectedStatus: 422 }
      );
      assert.equal(rejectedRead.error?.code, "VALIDATION_ERROR",
        "Rejected non-Markdown reference returned an invalid read error.");
    }
  }

  async function rejectUploadPath(relativePath, sizeBytes, expectedReason) {
    const created = await developer.json(`${knowledgeBaseRoute()}/upload-sessions`, {
      method: "POST",
      headers: { "idempotency-key": `${input.runId}-reject-${randomUUID()}` },
      json: { declaredFileCount: 1, declaredByteCount: sizeBytes },
      expectedStatus: 201
    });
    const sessionId = created.session.id;
    recordOkfV02OwnedResource(ownership, "uploadSessionIds", sessionId);
    const rejected = await developer.json(
      `${knowledgeBaseRoute()}/upload-sessions/${encodeURIComponent(sessionId)}/entries`,
      {
        method: "POST",
        json: { entries: [{ relativePath, declaredSize: sizeBytes }] },
        expectedStatus: 422
      }
    );
    assert(
      rejected.error?.code === "VALIDATION_ERROR"
        && rejected.error?.details?.reason === expectedReason,
      `The ${expectedReason} upload path did not return its documented error.`
    );
    await developer.json(
      `${knowledgeBaseRoute()}/upload-sessions/${encodeURIComponent(sessionId)}`,
      { method: "DELETE" }
    );
  }

  async function replaceAndVerify(sourceFileId, markdown, expectation) {
    const source = await getSourceFile(sourceFileId);
    const accepted = await developer.json(
      `${knowledgeBaseRoute()}/source-files/${encodeURIComponent(sourceFileId)}/content`,
      {
        method: "PUT",
        headers: {
          "content-type": "text/markdown; charset=utf-8",
          "if-match": `"${source.resourceRevision}"`,
          "idempotency-key": `${input.runId}-replace-${randomUUID()}`
        },
        rawBody: Buffer.from(markdown),
        expectedStatus: 202
      }
    );
    const operationId = accepted.operation.operationId;
    recordOkfV02OwnedResource(ownership, "operationIds", operationId);
    try {
      await waitForOperation(operationId);
    } catch (error) {
      throw new Error(
        `OKF replacement failed for ${expectation.id ?? "valid-metadata"}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
    const visible = await waitForVisibleSource(sourceFileId);
    const projection = await waitForProjectedFile(visible);
    assertPartial(projection.file.frontmatter, expectation.expectedRaw ?? {}, "direct frontmatter");
    assertPartial(projection.file.okfSignals, expectation.expectedSignals ?? {}, "direct OKF signals");
    assertPartial(projection.search.frontmatter, expectation.expectedRaw ?? {}, "search frontmatter");
    assertPartial(projection.search.okfSignals, expectation.expectedSignals ?? {}, "search OKF signals");
    if (expectation.excludedFilter) {
      const filterValue = {
        okfStatus: "stable",
        okfTrustTier: "human-reviewed",
        okfFreshness: "fresh"
      }[expectation.excludedFilter];
      const filtered = await developer.json(searchPath({
        query: TOKEN,
        [expectation.excludedFilter]: filterValue,
        limit: 50
      }));
      assert(
        !filtered.items.some((item) => item.fileId === projection.file.fileId),
        `${expectation.excludedFilter} did not exclude an unknown signal.`
      );
    }
    await Promise.all([
      developer.json(`${knowledgeBaseRoute()}/graph/overview`),
      developer.json(
        `${knowledgeBaseRoute()}/graph/expand?fileId=${encodeURIComponent(projection.file.fileId)}&depth=1&fanout=5&limit=20`
      ),
      developer.json(
        `${knowledgeBaseRoute()}/files/${encodeURIComponent(projection.file.fileId)}/related?limit=20`
      ),
      developer.text(
        `${knowledgeBaseRoute()}/files/${encodeURIComponent(projection.file.fileId)}/content`
      ),
      developer.text(
        `${knowledgeBaseRoute()}/files/content?path=${encodeURIComponent(projection.file.path)}`
      )
    ]);
    return projection;
  }

  async function waitForProjectedFile(source) {
    const deadline = Date.now() + OPERATION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const parentPath = path.posix.dirname(source.generatedPath);
      const tree = await developer.json(
        `${knowledgeBaseRoute()}/tree?parentPath=${encodeURIComponent(parentPath)}&limit=500`
      );
      const entry = tree.items.find((item) => item.sourceFileId === source.sourceFileId);
      if (entry?.fileId) {
        const file = await developer.json(
          `${knowledgeBaseRoute()}/files/${encodeURIComponent(entry.fileId)}`
        );
        const search = await developer.json(searchPath({ query: TOKEN, limit: 50 }));
        const hit = search.items.find((item) => item.fileId === entry.fileId);
        if (hit && file.file?.fileId === entry.fileId) {
          return { file: file.file, search: hit };
        }
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error("The replaced OKF file did not reach active search projection.");
  }

  async function runSearchMatrix(ids) {
    const unfiltered = await developer.json(searchPath({ query: TOKEN, limit: 50 }));
    const unfilteredFileIds = unfiltered.items.map((item) => item.fileId).sort();
    assert(unfilteredFileIds.includes(ids.stableFileId), "Unfiltered search omitted the valid OKF file.");
    assert(unfilteredFileIds.includes(ids.nullableFileId), "Unfiltered search omitted the nullable OKF file.");
    for (const [filter, value] of [
      ["okfStatus", "stable"],
      ["okfTrustTier", "human-reviewed"],
      ["okfFreshness", "fresh"]
    ]) {
      const result = await developer.json(searchPath({
        query: TOKEN,
        [filter]: value,
        limit: 50
      }));
      assert(result.items.some((item) => item.fileId === ids.stableFileId), `${filter} omitted the valid file.`);
      assert(!result.items.some((item) => item.fileId === ids.nullableFileId), `${filter} included the nullable file.`);
    }
    const combined = await developer.json(searchPath({
      query: TOKEN,
      okfStatus: "stable",
      okfTrustTier: "human-reviewed",
      okfFreshness: "fresh",
      mode: "hybrid",
      limit: 50
    }));
    assert(combined.items.some((item) => item.fileId === ids.stableFileId), "Combined OKF filters omitted the valid file.");
    const stale = await developer.json(searchPath({ query: TOKEN, okfFreshness: "stale", limit: 50 }));
    assert(!stale.items.some((item) => item.fileId === ids.stableFileId), "Stale filter included a fresh file.");
    const unrelated = await developer.json(searchPath({ query: TOKEN, fileKind: "index", limit: 50 }));
    assert(!unrelated.items.some((item) => item.fileId === ids.stableFileId), "File-kind filter included a page.");
    const firstPage = await developer.json(searchPath({ query: TOKEN, limit: 1 }));
    if (firstPage.nextCursor) {
      await developer.json(searchPath({
        query: TOKEN,
        okfStatus: "stable",
        cursor: firstPage.nextCursor,
        limit: 1
      }), { expectedStatus: 422 });
    }
    for (const [filter, value] of [
      ["okfStatus", "unknown"],
      ["okfTrustTier", "trusted"],
      ["okfFreshness", "current"]
    ]) {
      await developer.json(searchPath({ query: TOKEN, [filter]: value }), {
        expectedStatus: 422
      });
    }
    await developer.json(searchPath({ query: TOKEN, cursor: "invalid-cursor" }), {
      expectedStatus: 422
    });
    return {
      unfilteredFileIds,
      stableFileId: ids.stableFileId,
      nullableFileId: ids.nullableFileId,
      responseBytes: Buffer.byteLength(JSON.stringify(unfiltered))
    };
  }

  async function inspectGeneratedArtifacts(targets) {
    const [root, schema, log, pages, indexExtension, graphExtension] = await Promise.all([
      generatedContent("index.md"),
      generatedContent("schema.md"),
      generatedContent("log.md"),
      generatedContent("pages/index.md"),
      generatedContent("_index/index.md"),
      generatedContent("_graph/index.md")
    ]);
    assert(/okf_version:\s*['"]?0\.2/u.test(root), "Root index is not native OKF 0.2.");
    assert(root.includes("/_index/index.md") && root.includes("/_graph/index.md"), "Root navigation lost OKF extensions.");
    assert(
      schema.includes("0.2") && /recommended/iu.test(schema),
      "Generated schema guidance is not aligned with OKF 0.2."
    );
    assert(log.includes("# Directory Update Log"), "Generated log structure changed.");
    assert(pages.includes("#") && indexExtension.includes("#") && graphExtension.includes("#"), "Generated navigation files are incomplete.");
    const tree = await listGeneratedTree();
    const paths = tree.filter((entry) => entry.entryType === "file").map((entry) => entry.path);
    assert(paths.includes("_index/catalog.json"), "Projection catalog is missing.");
    assert(paths.some((logicalPath) =>
      /^pages\/.+\/index\.md$/u.test(logicalPath)), "Nested page navigation is missing.");
    assert(paths.some((logicalPath) =>
      /^pages(?:\/.+)?\/index-(?!map-)[^/]+\.md$/u.test(logicalPath)),
    "Stable page continuation leaves are missing.");
    assert(paths.every((logicalPath) => !/\/index-map-\d{6}\.md$/u.test(logicalPath)),
      "Deprecated page continuation files are still present.");
    assert(paths.some((logicalPath) =>
      /^_index\/.+\/index\.md$/u.test(logicalPath)), "Index extension navigation is missing.");
    assert(paths.some((logicalPath) =>
      /^_graph\/.+\/index\.md$/u.test(logicalPath)), "Graph extension navigation is missing.");
    assert(paths.some((logicalPath) =>
      /^_index\/(?:manifest|search|links|tree)\/v1\/.+\.json$/u.test(logicalPath)),
    "Index projection shards are missing.");
    assert(paths.some((logicalPath) =>
      /^_graph\/(?:graph_node|graph_edge)\/v1\/.+\.json$/u.test(logicalPath)),
    "Graph projection shards are missing.");
    assert(paths.some((logicalPath) =>
      /^_graph\/by-file\/.+\.json$/u.test(logicalPath)),
    "Per-file graph resources are missing.");

    const catalog = JSON.parse(await generatedContent("_index/catalog.json"));
    for (const projection of [
      "manifest", "search", "links", "tree", "graphNodes", "graphEdges"
    ]) {
      assert(Array.isArray(catalog.projections?.[projection]?.shards),
        `Projection descriptor is missing for ${projection}.`);
    }
    const representativeShards = paths.filter((logicalPath) =>
      /^_(?:index|graph)\/.+\.json$/u.test(logicalPath)).slice(0, 8);
    for (const logicalPath of representativeShards) {
      JSON.parse(await generatedContent(logicalPath));
    }
    const [valid, malformed, incomplete] = await Promise.all([
      generatedContent(targets.validPath),
      generatedContent(targets.malformedPath),
      generatedContent(targets.incompleteAttestedPath)
    ]);
    inspectOkfV02RepresentativePages({ valid, malformed, incomplete });
    assert.deepEqual(findUnexpectedOkfV02RejectedGeneratedPaths({
      generatedPaths: paths,
      rejectedNonMarkdownPaths: input.official.nonMarkdown.map((entry) => entry.relativePath)
    }), [], "Rejected non-Markdown assets appeared in the generated tree.");
    return {
      generatedFileCount: paths.length,
      nestedIndexCount: paths.filter((logicalPath) =>
        /^pages\/.+\/index\.md$/u.test(logicalPath)).length,
      continuationLeafCount: paths.filter((logicalPath) =>
        /\/index-(?!map-)[^/]+\.md$/u.test(logicalPath)).length,
      projectionShardCount: paths.filter((logicalPath) =>
        /^_(?:index|graph)\/.+\.json$/u.test(logicalPath)).length
    };
  }

  async function listGeneratedTree() {
    const entries = [];
    const pending = [""];
    const visited = new Set();
    while (pending.length > 0) {
      const parentPath = pending.shift();
      if (visited.has(parentPath)) continue;
      visited.add(parentPath);
      const children = await listAll(
        developer,
        `${knowledgeBaseRoute()}/tree?parentPath=${encodeURIComponent(parentPath)}&limit=500`
      );
      entries.push(...children);
      for (const child of children) {
        if (child.entryType === "directory") pending.push(child.path);
      }
    }
    return entries;
  }

  async function runNoopPublicationCheck(targets, sourceFileId) {
    assert(input.storeObserver, "No-op publication store observer is unavailable.");
    assert.equal(typeof input.captureResourceSnapshot, "function");
    const before = await input.storeObserver.capture(input.knowledgeBaseId);
    const beforeGenerated = await generatedSnapshot(targets);
    const source = await getSourceFile(sourceFileId);
    const sourceContent = await developer.text(
      `${knowledgeBaseRoute()}/source-files/${encodeURIComponent(sourceFileId)}/content`
    );
    const sampler = createOkfV02ResourceSampler({
      intervalMs: 2_000,
      capture: input.captureResourceSnapshot
    });
    const startedAt = Date.now();
    await sampler.start();
    let resources;
    try {
      const rejected = await developer.json(
        `${knowledgeBaseRoute()}/source-files/${encodeURIComponent(sourceFileId)}/content`,
        {
          method: "PUT",
          headers: {
            "content-type": "text/markdown; charset=utf-8",
            "if-match": `"${source.resourceRevision}"`,
            "idempotency-key": `${input.runId}-noop-publication`
          },
          rawBody: Buffer.from(sourceContent),
          expectedStatus: 409
        }
      );
      assert.equal(rejected.error?.code, "CONFLICT",
        "Unchanged source replacement returned an invalid no-op error.");
      await sleep(500);
    } finally {
      resources = await sampler.stop();
    }
    const after = await input.storeObserver.capture(input.knowledgeBaseId);
    const afterGenerated = await generatedSnapshot(targets);
    const summary = summarizeOkfV02NoopPublication({
      before,
      after,
      beforeGenerated,
      afterGenerated,
      elapsedMs: Date.now() - startedAt,
      maximumCpuPercent: resources.maximumCpuPercent
    });
    return {
      ...summary,
      maximumRssBytes: resources.maximumRssBytes,
      postgresTransactionDelta: after.postgresTransactions - before.postgresTransactions,
      redisCommandDelta: after.redisCommandsProcessed - before.redisCommandsProcessed,
      s3ObjectCount: after.s3ObjectCount,
      searchDocumentCount: after.searchDocumentCount
    };
  }

  async function generatedSnapshot(targets) {
    const contents = await Promise.all([
      generatedContent("index.md"),
      generatedContent("schema.md"),
      generatedContent(targets.validPath),
      generatedContent(targets.incompleteAttestedPath)
    ]);
    return contents.join("\n<!-- OKF V0.2 SNAPSHOT BOUNDARY -->\n");
  }

  async function requestIndexMaintenance(idempotencyKey) {
    const requested = await admin.json(
      `/admin/api/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}/index-maintenance`,
      {
        method: "POST",
        headers: { origin, "idempotency-key": idempotencyKey },
        json: {},
        expectedStatus: 202
      }
    );
    if (requested.maintenance?.requestId) {
      recordOkfV02OwnedResource(ownership, "operationIds", requested.maintenance.requestId);
    }
    return requested;
  }

  async function generatedContent(generatedPath) {
    return developer.text(
      `${knowledgeBaseRoute()}/files/content?path=${encodeURIComponent(generatedPath)}`
    );
  }

  async function recordRunOperations() {
    const operations = await listAll(developer, `${knowledgeBaseRoute()}/operations?limit=100`);
    for (const operation of operations) {
      recordOkfV02OwnedResource(ownership, "operationIds", operation.operationId);
    }
  }

  async function waitForOperation(operationId) {
    const deadline = Date.now() + OPERATION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const data = await developer.json(
        `${knowledgeBaseRoute()}/operations/${encodeURIComponent(operationId)}`
      );
      if (data.operation.state === "completed") return data.operation;
      if (["failed", "cancelled", "superseded"].includes(data.operation.state)) {
        throw new Error(
          `operation ${operationId} ended in ${data.operation.state}`
          + ` (${data.operation.errorCode ?? "UNKNOWN"})`
        );
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error("OKF replacement operation timed out.");
  }

  async function waitForVisibleSource(sourceFileId) {
    const deadline = Date.now() + OPERATION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const source = await getSourceFile(sourceFileId);
      if (source.state === "visible" && source.generatedPath) return source;
      if (source.state === "failed") throw new Error("OKF source processing failed.");
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error("OKF source processing timed out.");
  }

  async function getSourceFile(sourceFileId) {
    return (await developer.json(
      `${knowledgeBaseRoute()}/source-files/${encodeURIComponent(sourceFileId)}`
    )).sourceFile;
  }

  async function processingSummary() {
    return admin.json(
      `/admin/api/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}/processing-summary`
    );
  }

  async function waitForIndexMaintenance() {
    const deadline = Date.now() + OPERATION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      input.assertRuntimeHealthy?.();
      const summary = await processingSummary();
      const maintenance = summary.indexMaintenance;
      if (maintenance?.state === "completed" && maintenance.maintenanceRequired === false) return;
      if (["failed", "cancelled"].includes(maintenance?.state)) {
        throw new Error("Manual search-provider maintenance failed.");
      }
      await sleep(1_000);
    }
    throw new Error("Manual search-provider maintenance timed out.");
  }

  async function waitUntilMissing(pathname) {
    const deadline = Date.now() + OPERATION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const response = await developer.request(pathname);
      if (response.status === 404) return;
      if (!response.ok) throw new Error(`Cleanup read returned HTTP ${response.status}.`);
      await response.text();
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error("Knowledge-base cleanup timed out.");
  }

  function knowledgeBaseRoute() {
    return `/openapi/v2/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}`;
  }

  function searchPath(query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) params.set(key, String(value));
    }
    return `${knowledgeBaseRoute()}/files/search?${params}`;
  }
}

export function resolveOkfV02RunOwnership(input) {
  return input.ownership ?? input.journal?.state?.ownership;
}

function createHttpClient(input) {
  let cookie = "";
  let authorization = "";
  return {
    get authorization() {
      return authorization;
    },
    set authorization(value) {
      authorization = value ?? "";
    },
    async request(pathname, options = {}) {
      for (let attempt = 0; ; attempt += 1) {
        const response = await fetch(new URL(pathname, input.baseUrl), {
          method: options.method ?? "GET",
          headers: {
            ...(cookie ? { cookie } : {}),
            ...(authorization ? { authorization } : {}),
            ...(options.json ? { "content-type": "application/json" } : {}),
            ...(options.headers ?? {})
          },
          body: options.rawBody ?? (
            options.json === undefined ? options.body : JSON.stringify(options.json)
          ),
          signal: options.signal ?? AbortSignal.timeout(30_000)
        });
        const setCookie = response.headers.get("set-cookie");
        if (setCookie) cookie = setCookie.split(";")[0] ?? "";
        await input.responseValidator?.validateFetchResponse({
          method: options.method ?? "GET",
          pathname,
          response
        });
        if (response.status !== 429 || attempt >= 4) return response;
        await response.text();
        await sleep(1_000);
      }
    },
    async json(pathname, options = {}) {
      const response = await this.request(pathname, options);
      const text = await response.text();
      const body = text ? JSON.parse(text) : null;
      assertExpectedStatus(response.status, options.expectedStatus, pathname);
      return body;
    },
    async text(pathname, options = {}) {
      const response = await this.request(pathname, options);
      const text = await response.text();
      assertExpectedStatus(response.status, options.expectedStatus, pathname);
      try {
        const parsed = JSON.parse(text);
        return parsed.content ?? text;
      } catch {
        return text;
      }
    }
  };
}

async function listAll(client, pathname) {
  const items = [];
  let cursor = null;
  do {
    const separator = pathname.includes("?") ? "&" : "?";
    const page = await client.json(
      `${pathname}${cursor ? `${separator}cursor=${encodeURIComponent(cursor)}` : ""}`
    );
    items.push(...(page.items ?? []));
    cursor = page.nextCursor ?? null;
  } while (cursor);
  return items;
}

function assertExpectedStatus(status, expected, pathname) {
  const expectedStatuses = Array.isArray(expected)
    ? expected
    : [expected ?? 200];
  if (!expectedStatuses.includes(status)) {
    throw new Error(`HTTP ${status} for ${pathname}; expected ${expectedStatuses.join(" or ")}.`);
  }
}

function assertPartial(actual, expected, label) {
  assert(actual && typeof actual === "object", `${label} is unavailable.`);
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(actual[key], value, `${label}.${key} does not match.`);
  }
}

function assertCorpusBaseline(baseline) {
  assert.equal(baseline?.totalCompared, 200, "The exact OKF baseline was not fully compared.");
  assert.equal(baseline.officialCompared, 53, "Official OKF concept comparison is incomplete.");
  assert.equal(baseline.legacyCompared, 147, "Legacy OKF comparison is incomplete.");
  for (const field of [
    "officialWithSources",
    "officialWithGenerated",
    "officialWithVerified",
    "officialAttestedComputations",
    "legacyWithTimestamp",
    "legacyWithUnknownMetadata",
    "legacyWithChineseContent",
    "legacyWithCitations"
  ]) {
    assert(baseline[field] > 0, `The OKF baseline did not cover ${field}.`);
  }
  assert.equal(baseline.fabricatedProvenanceCount, 0,
    "The OKF baseline introduced fabricated provenance.");
}

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the OKF 0.2 E2E.`);
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
