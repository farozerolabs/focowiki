import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSkillCurlCommandPlan,
  normalizeSkillBaseUrl,
  selectSkillCommandInputs,
  summarizeSkillCommandResults,
  validateSkillCurlCommands
} from "../lib/skill-curl-validation.mjs";
import {
  DEMO_SKILL_AGENT_REPORT_PATH,
  DEMO_SKILL_CHANGE_ID,
  DEMO_SKILL_DEVELOPER_REPORT_PATH,
  DEMO_SKILL_OKF_REPORT_PATH,
  reportPaths
} from "../lib/agent-openapi-report.mjs";

test("skill curl command plan covers documented read categories without auth", () => {
  const plan = buildSkillCurlCommandPlan({
    demoBaseUrl: "http://127.0.0.1:45010/agent/v1",
    fileId: "file_1",
    graphPath: "_graph/by-file/file_1.json",
    searchQuery: "upload lifecycle"
  });
  const categories = new Set(plan.map((command) => command.category));

  assert.deepEqual(
    [...categories].sort(),
    [
      "content-by-id",
      "content-by-path",
      "file-metadata",
      "graph-by-path",
      "health",
      "knowledge-base",
      "related-files",
      "search",
      "tree"
    ].sort()
  );
  assert.equal(plan.some((command) => /Authorization|Bearer|OPENAPI_KEY/i.test(command.displayCommand)), false);
});

test("skill curl command plan normalizes demo root URL to Agent route base", () => {
  assert.equal(normalizeSkillBaseUrl("http://127.0.0.1:45012"), "http://127.0.0.1:45012/agent/v1");
  assert.equal(normalizeSkillBaseUrl("http://127.0.0.1:45012/agent/v1"), "http://127.0.0.1:45012/agent/v1");

  const plan = buildSkillCurlCommandPlan({
    demoBaseUrl: "http://127.0.0.1:45012",
    fileId: "file_1",
    graphPath: "_graph/by-file/file_1.json"
  });

  assert.equal(plan[0].args.includes("http://127.0.0.1:45012/agent/v1/health"), true);
});

test("skill command input selection prefers generated reusable identifiers", () => {
  const inputs = selectSkillCommandInputs({
    inspectedPages: [
      {
        frontmatter: { fileId: "file_123", title: "Visible title" },
        file: { fileId: "file_123", path: "pages/visible.md" }
      }
    ],
    inventory: [{ path: "_graph/by-file/file_123.json" }],
    searchEntries: []
  });

  assert.equal(inputs.fileId, "file_123");
  assert.equal(inputs.pagePath, "pages/visible.md");
  assert.equal(inputs.graphPath, "_graph/by-file/file_123.json");
  assert.equal(inputs.searchQuery, "Visible title");
});

test("demo skill validation reports use demo-skill local report names", () => {
  assert.deepEqual(reportPaths(DEMO_SKILL_CHANGE_ID), [
    DEMO_SKILL_AGENT_REPORT_PATH,
    DEMO_SKILL_DEVELOPER_REPORT_PATH,
    DEMO_SKILL_OKF_REPORT_PATH
  ]);
});

test("skill curl commands execute against a demo-compatible HTTP surface", async (t) => {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(routeFixture(url)));
  });
  const listener = await listenForTest(server);
  if (!listener.ok) {
    t.skip(`Local listener is unavailable in this environment: ${listener.error.code || listener.error.message}`);
    return;
  }
  t.after(() => server.close());

  const address = listener.address;
  const result = await validateSkillCurlCommands({
    demoBaseUrl: `http://127.0.0.1:${address.port}/agent/v1`,
    generated: {
      inspectedPages: [
        {
          frontmatter: { fileId: "file_1", title: "Upload lifecycle" },
          file: { fileId: "file_1", path: "pages/upload-lifecycle.md" }
        }
      ],
      inventory: [
        { path: "pages/upload-lifecycle.md", fileId: "file_1" },
        { path: "_graph/by-file/file_1.json", fileId: "graph_1" }
      ],
      searchEntries: [{ fileId: "file_1", path: "pages/upload-lifecycle.md", title: "Upload lifecycle" }]
    },
    requestTimeoutMs: 5_000
  });

  assert.equal(result.summary.total, 10);
  assert.equal(result.summary.passed, 10);
  assert.equal(result.summary.failed, 0);
  assert.equal(result.summary.skipped, 0);
  assert.equal(result.summary.leaked, 0);
  assert.equal(result.commands.every((command) => command.identifierContinuity || command.category === "health"), true);
});

test("skill command summary counts skipped identifier commands", () => {
  const summary = summarizeSkillCommandResults([
    { ok: true, skipped: false, identifierContinuity: true, requiresIdentifierContinuity: true },
    { ok: false, skipped: true, identifierContinuity: false, requiresIdentifierContinuity: true },
    { ok: false, skipped: false, leakDetected: true, identifierContinuity: false, requiresIdentifierContinuity: true }
  ]);

  assert.equal(summary.passed, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.leaked, 1);
  assert.equal(summary.identifierContinuityFailed, 1);
});

function routeFixture(url) {
  if (url.pathname === "/agent/v1/health") return { status: "ok" };
  if (url.pathname === "/agent/v1/knowledge-base") {
    return { knowledgeBase: { knowledgeBaseId: "kb_1", name: "Demo" } };
  }
  if (url.pathname === "/agent/v1/tree") {
    return { items: [{ fileId: "file_1", path: "pages/upload-lifecycle.md", title: "Upload lifecycle" }], nextCursor: null };
  }
  if (url.pathname === "/agent/v1/search") {
    return { items: [{ fileId: "file_1", path: "pages/upload-lifecycle.md", title: "Upload lifecycle" }], nextCursor: null };
  }
  if (url.pathname === "/agent/v1/files/file_1") {
    return { fileId: "file_1", path: "pages/upload-lifecycle.md", title: "Upload lifecycle" };
  }
  if (url.pathname === "/agent/v1/files/file_1/content") {
    return {
      file: { fileId: "file_1", path: "pages/upload-lifecycle.md", title: "Upload lifecycle" },
      content: "---\ntitle: Upload lifecycle\nfileId: file_1\n---\n# Upload lifecycle"
    };
  }
  if (url.pathname === "/agent/v1/files/file_1/related") {
    return { items: [{ fileId: "file_2", path: "pages/related.md", title: "Related" }], nextCursor: null };
  }
  if (url.pathname === "/agent/v1/files/content") {
    const requestedPath = url.searchParams.get("path") || "index.md";
    const content = requestedPath.endsWith(".json")
      ? JSON.stringify({ items: [{ fileId: "file_2", path: "pages/related.md", relationType: "related" }] })
      : `# ${requestedPath}`;
    return {
      file: { fileId: requestedPath.includes("_graph/") ? "graph_1" : "root_1", path: requestedPath, title: requestedPath },
      content
    };
  }
  return { error: { code: "NOT_FOUND", message: "Not found", httpStatus: 404 } };
}

function listenForTest(server) {
  return new Promise((resolve) => {
    const onError = (error) => {
      server.off("listening", onListening);
      resolve({ ok: false, error });
    };
    const onListening = () => {
      server.off("error", onError);
      resolve({ ok: true, address: server.address() });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}
