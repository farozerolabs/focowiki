import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { loadEnvFile } from "node:process";
import {
  createPublicLifecycleBarriers,
  createUploadSessionPhaseClient,
  createLifecycleHttpClient
} from "./lib/interleaved-lifecycle-api.mjs";
import {
  assertInterleavedBoundaryCoverage,
  buildDeploymentBoundedMaintenanceCandidates,
  buildInterleavedBoundaryCorpus
} from "./lib/interleaved-boundary-corpus.mjs";
import {
  createInterleavedLifecycleController
} from "./lib/interleaved-lifecycle-controller.mjs";

loadLocalEnv();

const runId = requiredEnv("FOCOWIKI_INTERLEAVED_RUN_ID");
const reportRoot = path.resolve(
  "ReferenceDocs",
  "validate-interleaved-lifecycle-e2e"
);
const controller = createInterleavedLifecycleController({
  runId,
  seed: process.env.FOCOWIKI_INTERLEAVED_SEED || runId,
  reportRoot
});
await controller.initialize();
const fixture = buildInterleavedBoundaryCorpus();
writeJson(
  path.join(controller.state.evidenceDir, "boundary-corpus.json"),
  fixture
);
const adminOrigin = process.env.ADMIN_PUBLIC_ORIGIN || "http://127.0.0.1:43100";
const admin = createLifecycleHttpClient({
  baseUrl: `http://127.0.0.1:${process.env.ADMIN_API_PORT || "43000"}`
});
const developer = createLifecycleHttpClient({
  baseUrl: `http://127.0.0.1:${process.env.PUBLIC_OPENAPI_PORT || "43200"}`
});
const anonymous = createLifecycleHttpClient({
  baseUrl: `http://127.0.0.1:${process.env.PUBLIC_OPENAPI_PORT || "43200"}`
});
const results = [];
let keyId = null;
let knowledgeBaseId = null;
let secondaryKnowledgeBaseId = null;
let originalMaintenanceSettings = null;
let originalRateLimitSettings = null;
let coverage = null;
const scenarioId = controller.state.scenarios.some(
  (scenario) => scenario.scenarioId === "boundary-inputs"
)
  ? `boundary-inputs-regression-${Date.now()}`
  : "boundary-inputs";

controller.startScenario({
  scenarioId,
  family: "boundary",
  lifecycles: ["upload", "modification", "read"]
});

try {
  await admin.json("/admin/api/login", {
    method: "POST",
    headers: { origin: adminOrigin },
    json: {
      username: requiredEnv("ADMIN_USERNAME"),
      password: requiredEnv("ADMIN_PASSWORD")
    }
  });
  const credential = await admin.json("/admin/api/openapi-keys", {
    method: "POST",
    headers: { origin: adminOrigin },
    json: { name: `boundary-${runId}` },
    expectedStatus: 201
  });
  keyId = credential.key.id;
  developer.authorization = `Bearer ${credential.oneTimeKey.rawKey}`;

  const created = await developer.json("/openapi/v2/knowledge-bases", {
    method: "POST",
    headers: { "idempotency-key": `${runId}-boundary-kb` },
    json: {
      name: "Interleaved boundary validation",
      description: "Generic request boundary validation"
    },
    expectedStatus: 201
  });
  knowledgeBaseId = created.knowledgeBase.knowledgeBaseId;
  controller.registerOwnership("knowledgeBases", knowledgeBaseId);
  const secondary = await developer.json("/openapi/v2/knowledge-bases", {
    method: "POST",
    headers: { "idempotency-key": `${runId}-boundary-secondary-kb` },
    json: {
      name: "Interleaved boundary validation secondary",
      description: "Cross-context identity validation"
    },
    expectedStatus: 201
  });
  secondaryKnowledgeBaseId = secondary.knowledgeBase.knowledgeBaseId;
  controller.registerOwnership("knowledgeBases", secondaryKnowledgeBaseId);

  for (const file of fixture.files) {
    await validateFileFixture(file);
  }
  for (const duplicateSet of fixture.duplicateSets) {
    await validateDuplicateFixture(duplicateSet);
  }
  await validateProtocolFixtures(created.knowledgeBase.resourceRevision);
  coverage = assertInterleavedBoundaryCoverage(fixture, results);

  controller.completeScenario(scenarioId, { outcome: "succeeded" });
} catch (error) {
  controller.completeScenario(scenarioId, {
    outcome: "failed",
    errorCode: error?.code ?? "BOUNDARY_VALIDATION_FAILED"
  });
  throw error;
} finally {
  if (originalRateLimitSettings) {
    await admin.request("/admin/api/settings/rate-limits", {
      method: "PUT",
      headers: { origin: adminOrigin },
      json: originalRateLimitSettings
    }).catch(() => undefined);
  }
  if (originalMaintenanceSettings) {
    await admin.request("/admin/api/settings/maintenance", {
      method: "PUT",
      headers: { origin: adminOrigin },
      json: originalMaintenanceSettings
    }).catch(() => undefined);
  }
  if (secondaryKnowledgeBaseId) {
    await admin.request(
      `/admin/api/knowledge-bases/${encodeURIComponent(secondaryKnowledgeBaseId)}`,
      { method: "DELETE", headers: { origin: adminOrigin } }
    ).catch(() => undefined);
  }
  if (knowledgeBaseId) {
    await admin.request(
      `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`,
      { method: "DELETE", headers: { origin: adminOrigin } }
    ).catch(() => undefined);
  }
  if (keyId) {
    await admin.request(`/admin/api/openapi-keys/${encodeURIComponent(keyId)}`, {
      method: "DELETE",
      headers: { origin: adminOrigin }
    }).catch(() => undefined);
  }
  await admin.request("/admin/api/logout", {
    method: "POST",
    headers: { origin: adminOrigin }
  }).catch(() => undefined);
  await controller.persist();
  writeJson(
    path.join(controller.state.evidenceDir, "boundary-results.json"),
    {
      kind: "focowiki-interleaved-boundary-results",
      runId,
      passed: results.filter((result) => result.passed).length,
      failed: results.filter((result) => !result.passed).length,
      coverage,
      results
    }
  );
}

process.stdout.write(`${JSON.stringify({
  runId,
  passed: results.filter((result) => result.passed).length,
  failed: results.filter((result) => !result.passed).length
}, null, 2)}\n`);

async function validateFileFixture(file) {
  const session = await createSession(1, Buffer.byteLength(file.body));
  const response = await developer.request(
    `/openapi/v2/knowledge-bases/${encodeURIComponent(
      knowledgeBaseId
    )}/upload-sessions/${encodeURIComponent(session.id)}/entries`,
    {
      method: "POST",
      json: {
        entries: [{
          relativePath: file.relativePath,
          declaredSize: Buffer.byteLength(file.body),
          checksumSha256: sha256(file.body)
        }]
      }
    }
  );
  const accepted = response.ok;
  const expectedAccepted = file.expected !== "rejected_at_request";
  record(file.id, accepted === expectedAccepted, response.status);
  await cancelSession(session.id);
  assert(accepted === expectedAccepted, `Boundary mismatch for ${file.id}.`);
}

async function validateDuplicateFixture(fixtureSet) {
  const size = fixtureSet.files.reduce(
    (total, file) => total + Buffer.byteLength(file.body),
    0
  );
  const session = await createSession(fixtureSet.files.length, size);
  const response = await developer.request(
    `/openapi/v2/knowledge-bases/${encodeURIComponent(
      knowledgeBaseId
    )}/upload-sessions/${encodeURIComponent(session.id)}/entries`,
    {
      method: "POST",
      json: {
        entries: fixtureSet.files.map((file) => ({
          relativePath: file.relativePath,
          declaredSize: Buffer.byteLength(file.body),
          checksumSha256: sha256(file.body)
        }))
      }
    }
  );
  record(fixtureSet.id, !response.ok, response.status);
  await cancelSession(session.id);
  assert(!response.ok, `Duplicate boundary was accepted: ${fixtureSet.id}.`);
}

async function validateProtocolFixtures(resourceRevision) {
  const secondaryFixture = await createSecondarySourceFixture();
  await expectStatus(
    "invalid-knowledge-base-id",
    developer.request("/openapi/v2/knowledge-bases/not-a-knowledge-base"),
    [404]
  );
  await expectStatus(
    "cross-knowledge-base-file-id",
    developer.request(
      `/openapi/v2/knowledge-bases/${encodeURIComponent(
        knowledgeBaseId
      )}/source-files/${encodeURIComponent(secondaryFixture.sourceFileId)}`
    ),
    [404]
  );
  await expectStatus(
    "malformed-cursor",
    developer.request(
      `/openapi/v2/knowledge-bases/${encodeURIComponent(
        knowledgeBaseId
      )}/source-files?cursor=not-a-cursor`
    ),
    [422]
  );
  const knowledgeBasePage = await developer.json(
    "/openapi/v2/knowledge-bases?limit=1"
  );
  assert(
    knowledgeBasePage.nextCursor,
    "Cross-context cursor validation requires a knowledge-base list cursor."
  );
  await expectStatus(
    "cross-context-cursor",
    developer.request(
      `/openapi/v2/knowledge-bases/${encodeURIComponent(
        knowledgeBaseId
      )}/source-files?cursor=${encodeURIComponent(
        knowledgeBasePage.nextCursor
      )}`
    ),
    [422]
  );
  await expectStatus(
    "stale-resource-revision",
    developer.request(
      `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "if-match": `"${resourceRevision + 100}"`
        },
        json: { description: "stale" }
      }
    ),
    [409]
  );
  await expectStatus(
    "reused-operation-id",
    developer.request(
      `/openapi/v2/knowledge-bases/${encodeURIComponent(
        knowledgeBaseId
      )}/operations/${encodeURIComponent(secondaryFixture.operationId)}`
    ),
    [404]
  );
  await expectStatus(
    "invalid-idempotency-key",
    developer.request(
      `/openapi/v2/knowledge-bases/${encodeURIComponent(
        knowledgeBaseId
      )}/upload-sessions`,
      {
      method: "POST",
      headers: { "idempotency-key": "x".repeat(1_000) },
      json: { declaredFileCount: 1, declaredByteCount: 1 }
      }
    ),
    [400, 413, 422]
  );
  await expectStatus(
    "unsupported-method",
    developer.request(
      `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`,
      { method: "PROPFIND" }
    ),
    [404, 405]
  );
  await expectStatus(
    "unsupported-media-type",
    developer.request("/openapi/v2/knowledge-bases", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      rawBody: "invalid"
    }),
    [400, 415, 422]
  );
  await expectStatus(
    "invalid-utf8-transport",
    developer.request("/openapi/v2/knowledge-bases", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `${runId}-invalid-utf8`
      },
      rawBody: Buffer.from([0x7b, 0x22, 0x6e, 0x61, 0x6d, 0x65, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d])
    }),
    [400, 415, 422]
  );
  await expectStatus(
    "missing-authorization",
    anonymous.request("/openapi/v2/knowledge-bases"),
    [401]
  );
  await validateManifestRequestBodyBoundary();
  await expectStatus(
    "page-size-at-limit",
    developer.request("/openapi/v2/knowledge-bases?limit=200"),
    [200]
  );
  await expectStatus(
    "page-size-over-limit",
    developer.request("/openapi/v2/knowledge-bases?limit=1000000"),
    [400, 422]
  );
  await validateConcurrencyBoundary();
  await validateRequestCancellation();
  await validatePublicRateLimit();
}

async function createSecondarySourceFixture() {
  const content = Buffer.from(
    "---\ntitle: Boundary identity fixture\ntype: reference\n---\n\n# Boundary identity fixture\n\nGeneric cross-context validation.\n"
  );
  const upload = createUploadSessionPhaseClient({
    client: developer,
    knowledgeBaseId: secondaryKnowledgeBaseId,
    idempotencyPrefix: `${runId}-boundary-secondary`
  });
  const barriers = createPublicLifecycleBarriers({
    admin,
    developer,
    knowledgeBaseId: secondaryKnowledgeBaseId,
    timeoutMs: 300_000,
    pollIntervalMs: 250
  });
  const created = await upload.create([{
    relativePath: "identity/cross-context.md",
    bytes: content
  }]);
  const sessionId = created.session.id;
  await upload.appendManifest(sessionId);
  let sealed = await upload.seal(sessionId);
  for (
    let attempt = 0;
    sealed.session?.counts?.waitingReservation > 0 && attempt < 5;
    attempt += 1
  ) {
    sealed = await upload.reconcile(sessionId);
  }
  assert(
    !sealed.session?.counts?.waitingReservation,
    "Secondary boundary fixture retained path reservations."
  );
  const missing = await upload.get(sessionId, {
    transferState: "missing",
    limit: 500
  });
  const entry = missing.entries?.items?.[0];
  assert(entry?.sourceFileId, "Secondary boundary fixture returned no source-file ID.");
  await upload.uploadMissingContent(sessionId, missing.entries?.items ?? []);
  await upload.finalize(sessionId);
  await barriers.upload(upload, sessionId, ["completed"]);
  const visible = await barriers.sourceFile(entry.sourceFileId, ["visible"]);
  const replacement = await developer.json(
    `/openapi/v2/knowledge-bases/${encodeURIComponent(
      secondaryKnowledgeBaseId
    )}/source-files/${encodeURIComponent(entry.sourceFileId)}/content`,
    {
      method: "PUT",
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "idempotency-key": `${runId}-boundary-secondary-operation`,
        "if-match": `"${visible.resourceRevision}"`
      },
      rawBody: Buffer.concat([
        content,
        Buffer.from("\n\nUpdated for operation identity validation.\n")
      ]),
      expectedStatus: 202
    }
  );
  const operationId = replacement.operation?.operationId;
  assert(operationId, "Secondary boundary fixture returned no operation ID.");
  await barriers.operation(operationId, ["completed"]);
  return { sourceFileId: entry.sourceFileId, operationId };
}

async function validateManifestRequestBodyBoundary() {
  const atLimit = await createSession(500, 0);
  const atLimitResponse = await developer.request(
    `/openapi/v2/knowledge-bases/${encodeURIComponent(
      knowledgeBaseId
    )}/upload-sessions/${encodeURIComponent(atLimit.id)}/entries`,
    {
      method: "POST",
      json: {
        entries: manifestBoundaryEntries(500, "at-limit")
      }
    }
  );
  record("request-body-at-limit", atLimitResponse.status === 200, atLimitResponse.status);
  await cancelSession(atLimit.id);
  assert(
    atLimitResponse.status === 200,
    `request-body-at-limit returned HTTP ${atLimitResponse.status}.`
  );

  const overLimit = await createSession(501, 0);
  const overLimitResponse = await developer.request(
    `/openapi/v2/knowledge-bases/${encodeURIComponent(
      knowledgeBaseId
    )}/upload-sessions/${encodeURIComponent(overLimit.id)}/entries`,
    {
      method: "POST",
      json: {
        entries: manifestBoundaryEntries(501, "over-limit")
      }
    }
  );
  record(
    "request-body-over-limit",
    [400, 413, 422].includes(overLimitResponse.status),
    overLimitResponse.status
  );
  await cancelSession(overLimit.id);
  assert(
    [400, 413, 422].includes(overLimitResponse.status),
    `request-body-over-limit returned HTTP ${overLimitResponse.status}.`
  );
}

async function validateConcurrencyBoundary() {
  const runtime = await admin.json("/admin/api/settings/runtime");
  originalMaintenanceSettings = runtime.settings?.maintenance;
  assert(
    originalMaintenanceSettings,
    "Runtime settings did not expose maintenance configuration."
  );
  const { atLimit, overLimit } = buildDeploymentBoundedMaintenanceCandidates(
    originalMaintenanceSettings
  );
  await expectStatus(
    "concurrency-at-limit",
    admin.request("/admin/api/settings/maintenance", {
      method: "PUT",
      headers: { origin: adminOrigin },
      json: atLimit
    }),
    [200]
  );
  await expectStatus(
    "concurrency-over-limit",
    admin.request("/admin/api/settings/maintenance", {
      method: "PUT",
      headers: { origin: adminOrigin },
      json: overLimit
    }),
    [400]
  );
  const restored = await admin.request("/admin/api/settings/maintenance", {
    method: "PUT",
    headers: { origin: adminOrigin },
    json: originalMaintenanceSettings
  });
  assert(
    restored.status === 200,
    `Maintenance settings restoration returned HTTP ${restored.status}.`
  );
  originalMaintenanceSettings = null;
}

async function validateRequestCancellation() {
  const session = await createSession(1, 0);
  const abort = new AbortController();
  const request = developer.request(
    `/openapi/v2/knowledge-bases/${encodeURIComponent(
      knowledgeBaseId
    )}/upload-sessions/${encodeURIComponent(session.id)}/entries`,
    {
      method: "POST",
      signal: abort.signal,
      json: {
        entries: [{
          relativePath: "boundary/cancelled-request.md",
          declaredSize: 0,
          checksumSha256: sha256("")
        }]
      }
    }
  );
  abort.abort(new DOMException("Validation request cancelled.", "AbortError"));
  let cancelled = false;
  try {
    await request;
  } catch (error) {
    cancelled = error?.name === "AbortError";
  }
  await sleep(100);
  const current = await developer.json(
    `/openapi/v2/knowledge-bases/${encodeURIComponent(
      knowledgeBaseId
    )}/upload-sessions/${encodeURIComponent(session.id)}?limit=1`
  );
  const entryCount = current.entries?.items?.length ?? 0;
  const passed = cancelled && entryCount === 0;
  record("request-cancellation", passed, cancelled ? "aborted" : "completed");
  await cancelSession(session.id);
  assert(passed, "Cancelled request created partial upload-manifest state.");
}

async function validatePublicRateLimit() {
  const runtime = await admin.json("/admin/api/settings/runtime");
  originalRateLimitSettings = runtime.settings?.rateLimits;
  assert(
    originalRateLimitSettings,
    "Runtime settings did not expose rate-limit configuration."
  );
  const limited = {
    ...originalRateLimitSettings,
    publicOpenApi: {
      max: 1,
      windowSeconds: originalRateLimitSettings.publicOpenApi.windowSeconds
    }
  };
  const updated = await admin.request("/admin/api/settings/rate-limits", {
    method: "PUT",
    headers: { origin: adminOrigin },
    json: limited
  });
  assert(updated.status === 200, `Rate-limit setup returned HTTP ${updated.status}.`);

  let limitedResponse = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await developer.request("/openapi/v2/knowledge-bases?limit=1");
    if (response.status === 429) {
      limitedResponse = response;
      break;
    }
  }
  const passed = limitedResponse?.status === 429
    && /^\d+$/u.test(limitedResponse.headers.get("retry-after") ?? "");
  record("public-rate-limit", passed, limitedResponse?.status ?? null);

  const restored = await admin.request("/admin/api/settings/rate-limits", {
    method: "PUT",
    headers: { origin: adminOrigin },
    json: originalRateLimitSettings
  });
  assert(restored.status === 200, `Rate-limit restoration returned HTTP ${restored.status}.`);
  originalRateLimitSettings = null;
  assert(passed, "Public OpenAPI rate limit did not return a bounded 429 response.");
}

function manifestBoundaryEntries(count, prefix) {
  return Array.from({ length: count }, (_, index) => ({
    relativePath: `boundary/${prefix}-${String(index).padStart(3, "0")}.md`,
    declaredSize: 0,
    checksumSha256: sha256("")
  }));
}

async function createSession(declaredFileCount, declaredByteCount) {
  const response = await developer.json(
    `/openapi/v2/knowledge-bases/${encodeURIComponent(
      knowledgeBaseId
    )}/upload-sessions`,
    {
      method: "POST",
      headers: { "idempotency-key": `${runId}-${randomUUID()}` },
      json: { declaredFileCount, declaredByteCount },
      expectedStatus: 201
    }
  );
  return response.session;
}

function cancelSession(sessionId) {
  return developer.request(
    `/openapi/v2/knowledge-bases/${encodeURIComponent(
      knowledgeBaseId
    )}/upload-sessions/${encodeURIComponent(sessionId)}`,
    { method: "DELETE" }
  );
}

async function expectStatus(id, responsePromise, acceptedStatuses) {
  const response = await responsePromise;
  const passed = acceptedStatuses.includes(response.status);
  record(id, passed, response.status);
  assert(passed, `${id} returned HTTP ${response.status}.`);
}

function record(id, passed, status) {
  results.push({ id, passed, status });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600
  });
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function loadLocalEnv() {
  const envPath = process.env.ENV_FILE || ".env";
  if (fs.existsSync(envPath)) loadEnvFile(envPath);
}
