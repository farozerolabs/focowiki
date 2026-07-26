import assert from "node:assert/strict";
import test from "node:test";
import {
  createLifecycleHttpClient,
  createPublicLifecycleBarriers,
  createUploadSessionPhaseClient
} from "../lib/interleaved-lifecycle-api.mjs";

test("keeps admin cookies and developer bearer credentials on their own clients", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith("/admin/api/login")) {
      return response(200, { ok: true }, {
        "set-cookie": "session=admin; Path=/; HttpOnly"
      });
    }
    return response(200, { status: "ok" });
  };

  const admin = createLifecycleHttpClient({
    baseUrl: "http://127.0.0.1:43000",
    fetchImpl
  });
  await admin.json("/admin/api/login", {
    method: "POST",
    json: { username: "admin", password: "password" }
  });
  await admin.json("/admin/api/session");

  const developer = createLifecycleHttpClient({
    baseUrl: "http://127.0.0.1:43200",
    fetchImpl,
    authorization: "Bearer developer-key"
  });
  await developer.json("/openapi/v2/health");

  assert.equal(requests[1].init.headers.cookie, "session=admin");
  assert.equal(requests[2].init.headers.authorization, "Bearer developer-key");
  assert.equal(requests[2].init.headers.cookie, undefined);
});

test("pauses an upload session at each public lifecycle phase", async () => {
  const requests = [];
  const responses = [
    { session: { id: "upload-1", state: "draft" }, transport: { manifestPageSize: 100 } },
    { session: { id: "upload-1", state: "manifest_building" } },
    {
      session: { id: "upload-1", state: "manifest_sealed" },
      entries: [{
        id: "entry-1",
        relativePath: "folder/file.md",
        transferState: "missing"
      }]
    },
    { entry: { id: "entry-1", transferState: "uploaded" } },
    { session: { id: "upload-1", state: "finalizing" } }
  ];
  const client = createLifecycleHttpClient({
    baseUrl: "http://127.0.0.1:43200",
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return response(init.method === "POST" && requests.length === 1 ? 201 : 200, responses.shift());
    },
    authorization: "Bearer key"
  });
  const upload = createUploadSessionPhaseClient({
    client,
    knowledgeBaseId: "kb-validation",
    idempotencyPrefix: "validation-run"
  });

  const created = await upload.create([{
    relativePath: "folder/file.md",
    bytes: Buffer.from("# File\n")
  }]);
  await upload.appendManifest(created.session.id);
  const sealed = await upload.seal(created.session.id);
  await upload.uploadMissingContent(created.session.id, sealed.entries);
  await upload.finalize(created.session.id);

  assert.deepEqual(
    requests.map((request) => new URL(request.url).pathname),
    [
      "/openapi/v2/knowledge-bases/kb-validation/upload-sessions",
      "/openapi/v2/knowledge-bases/kb-validation/upload-sessions/upload-1/entries",
      "/openapi/v2/knowledge-bases/kb-validation/upload-sessions/upload-1/seal",
      "/openapi/v2/knowledge-bases/kb-validation/upload-sessions/upload-1/entries/entry-1/content",
      "/openapi/v2/knowledge-bases/kb-validation/upload-sessions/upload-1/finalize"
    ]
  );
});

test("replays upload session creation with a caller-owned idempotency key", async () => {
  const requests = [];
  const client = createLifecycleHttpClient({
    baseUrl: "http://127.0.0.1:43200",
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return response(201, {
        session: { id: "upload-replayed", state: "draft" },
        transport: { manifestPageSize: 100 }
      });
    },
    authorization: "Bearer key"
  });
  const upload = createUploadSessionPhaseClient({
    client,
    knowledgeBaseId: "kb-validation",
    idempotencyPrefix: "validation-run"
  });
  const files = [{
    relativePath: "folder/file.md",
    bytes: Buffer.from("# File\n")
  }];

  const first = await upload.create(files, {
    idempotencyKey: "validation-run-stable-upload"
  });
  const replay = await upload.create(files, {
    idempotencyKey: "validation-run-stable-upload"
  });

  assert.equal(first.session.id, replay.session.id);
  assert.deepEqual(
    requests.map((request) => request.init.headers["idempotency-key"]),
    ["validation-run-stable-upload", "validation-run-stable-upload"]
  );
});

test("cancels a caller-owned upload session after an interrupted flow", async () => {
  const requests = [];
  const responses = [
    {
      session: { id: "upload-cancelled", state: "draft" },
      transport: { manifestPageSize: 100 }
    },
    { session: { id: "upload-cancelled", state: "cancelled" } }
  ];
  const client = createLifecycleHttpClient({
    baseUrl: "http://127.0.0.1:43200",
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return response(requests.length === 1 ? 201 : 200, responses.shift());
    },
    authorization: "Bearer key"
  });
  const upload = createUploadSessionPhaseClient({
    client,
    knowledgeBaseId: "kb-validation",
    idempotencyPrefix: "validation-run"
  });

  const created = await upload.create([{
    relativePath: "folder/file.md",
    bytes: Buffer.from("# File\n")
  }]);
  const cancelled = await upload.cancel(created.session.id);

  assert.equal(cancelled.session.state, "cancelled");
  assert.equal(requests[1].init.method, "DELETE");
  assert.equal(
    new URL(requests[1].url).pathname,
    "/openapi/v2/knowledge-bases/kb-validation/upload-sessions/upload-cancelled"
  );
});

test("waits on operation, source, publication, and maintenance public states", async () => {
  const developerResponses = {
    operation: [
      { operation: { state: "processing" } },
      { operation: { state: "publishing" } }
    ],
    source: [
      { sourceFile: { state: "processing" } },
      { sourceFile: { state: "visible" } }
    ]
  };
  const adminResponses = [
    {
      publication: { stage: "projection" },
      maintenance: { state: "running", phase: "tree" }
    },
    {
      publication: { stage: "active" },
      maintenance: { state: "completed", phase: "cleanup" }
    }
  ];
  const barriers = createPublicLifecycleBarriers({
    knowledgeBaseId: "kb-validation",
    developer: {
      async json(pathname) {
        const key = pathname.includes("/operations/") ? "operation" : "source";
        return developerResponses[key].shift();
      }
    },
    admin: {
      async json() {
        return adminResponses.shift();
      }
    },
    pollIntervalMs: 0,
    timeoutMs: 100
  });

  assert.equal(
    (await barriers.operation("operation-1", ["publishing"])).state,
    "publishing"
  );
  assert.equal(
    (await barriers.sourceFile("source-1", ["visible"])).state,
    "visible"
  );
  assert.equal(
    (await barriers.publication(["projection"])).stage,
    "projection"
  );
  assert.equal(
    (await barriers.maintenance(["completed"])).state,
    "completed"
  );
});

function response(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}
