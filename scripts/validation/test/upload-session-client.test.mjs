import assert from "node:assert/strict";
import test from "node:test";

import { uploadMarkdownFilesWithSession } from "../lib/upload-session-client.mjs";

test("validation uploads use the complete nested upload-session lifecycle", async () => {
  const calls = [];
  const entries = [];
  const session = {
    id: "upload-session-test",
    counts: { waitingReservation: 0, rejectedDeleting: 0 }
  };
  const request = async (pathname, options = {}) => {
    calls.push({ pathname, options });
    if (pathname.endsWith("/upload-sessions") && options.method === "POST") {
      return {
        session,
        transport: { manifestPageSize: 1 }
      };
    }
    if (pathname.endsWith("/entries")) {
      for (const manifest of options.body.entries) {
        entries.push({
          id: `entry-${entries.length + 1}`,
          ...manifest,
          name: manifest.relativePath.split("/").at(-1),
          disposition: "upload_required",
          transferState: "missing",
          sourceFileId: null,
          generatedPath: `pages/${manifest.relativePath}`
        });
      }
      return { session };
    }
    if (pathname.endsWith("/seal")) return { session };
    const contentMatch = pathname.match(/\/entries\/([^/]+)\/content$/u);
    if (contentMatch) {
      const entry = entries.find((candidate) => candidate.id === contentMatch[1]);
      assert.equal(options.method, "PUT");
      assert.equal(options.headers["content-type"], "text/markdown; charset=utf-8");
      assert.ok(options.rawBody instanceof Uint8Array);
      if (entry) entry.transferState = "uploaded";
      return { entry };
    }
    if (pathname.endsWith("/finalize")) {
      entries.forEach((entry, index) => {
        entry.sourceFileId = `source-file-${index + 1}`;
      });
      return { session: { ...session, state: "completed" } };
    }
    if (options.query?.transferState === "missing") {
      return {
        session,
        entries: { items: entries.filter((entry) => entry.transferState === "missing"), nextCursor: null }
      };
    }
    return { session, entries: { items: entries, nextCursor: null } };
  };

  const result = await uploadMarkdownFilesWithSession({
    request,
    routeBase: "/openapi/v2/knowledge-bases/kb-test/upload-sessions",
    files: [
      { relativePath: "guides/intro.md", bytes: Buffer.from("# Intro") },
      { relativePath: "policies/intro.md", bytes: Buffer.from("# Policy") }
    ],
    idempotencyKey: "upload-session-test-key"
  });

  assert.deepEqual(result.files.map((file) => file.relativePath), [
    "guides/intro.md",
    "policies/intro.md"
  ]);
  assert.equal(result.files.every((file) => file.sourceFileId), true);
  assert.equal(calls.some((call) => call.pathname.includes("/uploads")), false);
  assert.equal(calls.filter((call) => call.pathname.endsWith("/entries")).length, 2);
  assert.equal(calls.filter((call) => /\/entries\/[^/]+\/content$/u.test(call.pathname)).length, 2);
  assert.equal(
    calls.find((call) => call.pathname.endsWith("/finalize"))?.options.status,
    200
  );
  assert.equal(calls.some((call) => call.options.formData), false);
  assert.deepEqual(result.transport, { manifestPageSize: 1 });
  assert.equal("limits" in result, false);
});

test("validation waits for asynchronous finalization before returning source file identities", async () => {
  const entries = [{
    id: "entry-1",
    relativePath: "guides/intro.md",
    name: "intro.md",
    declaredSize: 7,
    checksumSha256: "0".repeat(64),
    disposition: "upload_required",
    transferState: "missing",
    sourceFileId: "source-file-1",
    generatedPath: "pages/guides/intro.md"
  }];
  let statusReads = 0;
  const request = async (pathname, options = {}) => {
    if (pathname.endsWith("/upload-sessions") && options.method === "POST") {
      return {
        session: { id: "upload-session-async", state: "draft", counts: {} },
        transport: { manifestPageSize: 10 }
      };
    }
    if (pathname.endsWith("/entries")) return { session: { state: "manifest_building" } };
    if (pathname.endsWith("/seal")) {
      return { session: { state: "manifest_sealed", counts: { waitingReservation: 0, rejectedDeleting: 0 } } };
    }
    if (/\/entries\/entry-1\/content$/u.test(pathname)) {
      assert.equal(options.method, "PUT");
      assert.ok(options.rawBody instanceof Uint8Array);
      entries[0].transferState = "uploaded";
      return { entry: entries[0] };
    }
    if (pathname.endsWith("/finalize")) {
      return { session: { id: "upload-session-async", state: "finalizing" } };
    }
    if (options.query?.transferState === "missing") {
      return { session: { state: "uploading" }, entries: { items: entries, nextCursor: null } };
    }
    if (options.query?.limit === 1) {
      statusReads += 1;
      return {
        session: {
          id: "upload-session-async",
          state: statusReads === 1 ? "finalizing" : "completed"
        },
        entries: { items: entries, nextCursor: null }
      };
    }
    return { session: { state: "completed" }, entries: { items: entries, nextCursor: null } };
  };

  const result = await uploadMarkdownFilesWithSession({
    request,
    routeBase: "/openapi/v2/knowledge-bases/kb-test/upload-sessions",
    files: [{ relativePath: "guides/intro.md", bytes: Buffer.from("# Intro") }],
    finalizationPollIntervalMs: 0,
    finalizationTimeoutMs: 1_000
  });

  assert.equal(statusReads, 2);
  assert.equal(result.session.state, "completed");
  assert.equal(result.files[0]?.sourceFileId, "source-file-1");
});

test("validation rejects the removed upload limits contract", async () => {
  await assert.rejects(
    uploadMarkdownFilesWithSession({
      request: async () => ({
        session: { id: "upload-session-legacy" },
        limits: { manifestPageSize: 10 }
      }),
      routeBase: "/openapi/v2/knowledge-bases/kb-test/upload-sessions",
      files: [{ relativePath: "guides/intro.md", bytes: Buffer.from("# Intro") }]
    }),
    /session identity and transport/
  );
});
