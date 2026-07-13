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
        limits: {
          manifestPageSize: 1,
          contentBatchMaxFiles: 1,
          contentBatchMaxBytes: 1024,
          maxFileBytes: 1024
        }
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
    if (pathname.endsWith("/content")) {
      for (const key of options.formData.keys()) {
        const entry = entries.find((candidate) => candidate.id === key);
        if (entry) entry.transferState = "uploaded";
      }
      return { entries: entries.filter((entry) => entry.transferState === "uploaded") };
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
  assert.equal(calls.filter((call) => call.pathname.endsWith("/content")).length, 2);
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
        limits: {
          manifestPageSize: 10,
          contentBatchMaxFiles: 10,
          contentBatchMaxBytes: 1024,
          maxFileBytes: 1024
        }
      };
    }
    if (pathname.endsWith("/entries")) return { session: { state: "manifest_building" } };
    if (pathname.endsWith("/seal")) {
      return { session: { state: "manifest_sealed", counts: { waitingReservation: 0, rejectedDeleting: 0 } } };
    }
    if (pathname.endsWith("/content")) {
      entries[0].transferState = "uploaded";
      return { entries };
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
