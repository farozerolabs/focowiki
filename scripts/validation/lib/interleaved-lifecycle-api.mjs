import crypto from "node:crypto";
import { waitForStateBarrier } from "./interleaved-lifecycle-progress.mjs";

export function createLifecycleHttpClient(input) {
  if (!input?.baseUrl) throw new Error("Lifecycle HTTP client requires a base URL.");
  const fetchImpl = input.fetchImpl ?? fetch;
  let cookie = "";
  let authorization = input.authorization ?? "";

  const client = {
    get authorization() {
      return authorization;
    },
    set authorization(value) {
      authorization = value ?? "";
    },
    async request(pathname, options = {}) {
      const url = new URL(pathname, input.baseUrl);
      for (const [key, value] of Object.entries(options.query ?? {})) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
      const headers = {
        ...(cookie ? { cookie } : {}),
        ...(authorization ? { authorization } : {}),
        ...(options.json ? { "content-type": "application/json" } : {}),
        ...(options.headers ?? {})
      };
      const response = await fetchImpl(url.toString(), {
        method: options.method ?? "GET",
        headers,
        body: options.rawBody ?? (
          options.json === undefined
            ? options.body
            : JSON.stringify(options.json)
        ),
        signal: options.signal
      });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0] ?? "";
      return response;
    },
    async json(pathname, options = {}) {
      const response = await client.request(pathname, options);
      const text = await response.text();
      const body = text ? JSON.parse(text) : null;
      assertExpectedStatus(pathname, response, body, options.expectedStatus);
      return body;
    },
    async text(pathname, options = {}) {
      const response = await client.request(pathname, options);
      const text = await response.text();
      assertExpectedStatus(pathname, response, text, options.expectedStatus);
      return text;
    }
  };

  return client;
}

export function createUploadSessionPhaseClient(input) {
  const base = `/openapi/v2/knowledge-bases/${encodeURIComponent(
    input.knowledgeBaseId
  )}/upload-sessions`;
  const sessions = new Map();
  let sequence = 0;

  return {
    async create(files, options = {}) {
      const normalized = files.map(normalizeFile);
      sequence += 1;
      const response = await input.client.json(base, {
        method: "POST",
        headers: {
          "idempotency-key": options.idempotencyKey
            ?? `${input.idempotencyPrefix}-upload-${sequence}`
        },
        json: {
          declaredFileCount: normalized.length,
          declaredByteCount: normalized.reduce(
            (total, file) => total + file.bytes.byteLength,
            0
          )
        },
        expectedStatus: 201
      });
      const sessionId = response.session?.id;
      if (!sessionId) throw new Error("Upload session creation returned no ID.");
      sessions.set(sessionId, {
        files: normalized,
        manifestPageSize: response.transport?.manifestPageSize ?? 100
      });
      return response;
    },
    async appendManifest(sessionId) {
      const session = requireSession(sessions, sessionId);
      let response = null;
      for (const page of chunk(session.files, session.manifestPageSize)) {
        response = await input.client.json(
          `${base}/${encodeURIComponent(sessionId)}/entries`,
          {
            method: "POST",
            json: {
              entries: page.map((file) => ({
                relativePath: file.relativePath,
                declaredSize: file.bytes.byteLength,
                checksumSha256: crypto
                  .createHash("sha256")
                  .update(file.bytes)
                  .digest("hex")
              }))
            }
          }
        );
      }
      return response;
    },
    async seal(sessionId) {
      requireSession(sessions, sessionId);
      return input.client.json(
        `${base}/${encodeURIComponent(sessionId)}/seal`,
        { method: "POST" }
      );
    },
    async reconcile(sessionId) {
      requireSession(sessions, sessionId);
      return input.client.json(
        `${base}/${encodeURIComponent(sessionId)}/reconcile`,
        { method: "POST" }
      );
    },
    async get(sessionId, query = {}) {
      requireSession(sessions, sessionId);
      return input.client.json(`${base}/${encodeURIComponent(sessionId)}`, {
        query
      });
    },
    async uploadMissingContent(sessionId, suppliedEntries) {
      const session = requireSession(sessions, sessionId);
      const entries = suppliedEntries ?? await listMissingEntries(
        input.client,
        base,
        sessionId,
        session.manifestPageSize
      );
      const fileByPath = new Map(
        session.files.map((file) => [file.relativePath, file])
      );

      for (const entry of entries) {
        if (
          entry.transferState !== undefined &&
          entry.transferState !== "missing"
        ) {
          continue;
        }
        const file = fileByPath.get(entry.relativePath);
        if (!file) {
          throw new Error(`Upload entry has no local body: ${entry.relativePath}.`);
        }
        await input.client.json(
          `${base}/${encodeURIComponent(sessionId)}/entries/${encodeURIComponent(
            entry.id
          )}/content`,
          {
            method: "PUT",
            headers: { "content-type": "text/markdown; charset=utf-8" },
            rawBody: file.bytes
          }
        );
      }
      return entries;
    },
    async finalize(sessionId) {
      requireSession(sessions, sessionId);
      return input.client.json(
        `${base}/${encodeURIComponent(sessionId)}/finalize`,
        { method: "POST" }
      );
    },
    async cancel(sessionId) {
      requireSession(sessions, sessionId);
      return input.client.json(
        `${base}/${encodeURIComponent(sessionId)}`,
        { method: "DELETE" }
      );
    }
  };
}

export function createPublicLifecycleBarriers(input) {
  const knowledgeBaseId = encodeURIComponent(input.knowledgeBaseId);
  const timeoutMs = input.timeoutMs ?? 5 * 60_000;
  const pollIntervalMs = input.pollIntervalMs ?? 250;
  const wait = (description, sample, states, readState) =>
    waitForStateBarrier({
      description,
      sample,
      matches: (snapshot) => states.includes(readState(snapshot)),
      timeoutMs,
      pollIntervalMs
    });

  return {
    upload(upload, sessionId, states) {
      return wait(
        "upload session",
        async () => (await upload.get(sessionId, { limit: 1 })).session,
        states,
        (snapshot) => snapshot?.state
      );
    },
    operation(operationId, states) {
      return wait(
        "resource operation",
        async () => (
          await input.developer.json(
            `/openapi/v2/knowledge-bases/${knowledgeBaseId}/operations/${encodeURIComponent(
              operationId
            )}`
          )
        ).operation,
        states,
        (snapshot) => snapshot?.state
      );
    },
    sourceFile(sourceFileId, states) {
      return wait(
        "source file",
        async () => (
          await input.developer.json(
            `/openapi/v2/knowledge-bases/${knowledgeBaseId}/source-files/${encodeURIComponent(
              sourceFileId
            )}`
          )
        ).sourceFile,
        states,
        (snapshot) => snapshot?.state
      );
    },
    publication(stages) {
      return wait(
        "publication",
        async () => {
          const summary = await readProcessingSummary(input.admin, knowledgeBaseId);
          return summary.publicationProgress ?? summary.publication;
        },
        stages,
        (snapshot) => snapshot?.stage
      );
    },
    maintenance(states) {
      return wait(
        "maintenance",
        async () => {
          const summary = await readProcessingSummary(input.admin, knowledgeBaseId);
          return summary.maintenanceProgress ?? summary.maintenance;
        },
        states,
        (snapshot) => snapshot?.state
      );
    },
    activeRead(predicate) {
      return waitForStateBarrier({
        description: "active knowledge-base read",
        sample: async () => input.developer.json(
          `/openapi/v2/knowledge-bases/${knowledgeBaseId}`
        ),
        matches: predicate,
        timeoutMs,
        pollIntervalMs
      });
    }
  };
}

async function listMissingEntries(
  client,
  base,
  sessionId,
  manifestPageSize
) {
  const entries = [];
  let cursor = null;
  do {
    const response = await client.json(
      `${base}/${encodeURIComponent(sessionId)}`,
      {
        query: {
          transferState: "missing",
          limit: manifestPageSize,
          ...(cursor ? { cursor } : {})
        }
      }
    );
    entries.push(...(response.entries?.items ?? []));
    cursor = response.entries?.nextCursor ?? null;
  } while (cursor);
  return entries;
}

function normalizeFile(file) {
  const relativePath = String(file.relativePath ?? "").normalize("NFC");
  if (!relativePath.toLowerCase().endsWith(".md")) {
    throw new Error("Lifecycle uploads accept Markdown files only.");
  }
  return {
    relativePath,
    bytes: file.bytes instanceof Uint8Array
      ? file.bytes
      : new Uint8Array(file.bytes)
  };
}

function requireSession(sessions, sessionId) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Unknown upload session: ${sessionId}.`);
  return session;
}

function chunk(values, size) {
  const pages = [];
  for (let offset = 0; offset < values.length; offset += size) {
    pages.push(values.slice(offset, offset + size));
  }
  return pages;
}

function assertExpectedStatus(pathname, response, body, expectedStatus) {
  const accepted = expectedStatus === undefined
    ? response.ok
    : response.status === expectedStatus;
  if (!accepted) {
    throw new Error(
      `HTTP ${response.status} for ${pathname}: ${safeBodySummary(body)}`
    );
  }
}

function safeBodySummary(body) {
  if (!body || typeof body !== "object") return String(body).slice(0, 500);
  return JSON.stringify({
    error: body.error
      ? {
          code: body.error.code,
          message: body.error.message,
          retryAfterSeconds: body.error.retryAfterSeconds
        }
      : undefined
  });
}

function readProcessingSummary(admin, knowledgeBaseId) {
  return admin.json(
    `/admin/api/knowledge-bases/${knowledgeBaseId}/processing-summary`
  );
}
