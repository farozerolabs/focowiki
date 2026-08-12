import assert from "node:assert/strict";
import test from "node:test";

import * as fullFlow from "../full-flow-e2e.mjs";
import { resolveOkfV02RunOwnership } from
  "../lib/okf-v02-http-e2e.mjs";

const PINNED_REVISION = "930b65fc3f5619d5d0591f88c72ebae8b848d60d";

test("OKF 0.2 HTTP stages retain the shared runtime ownership record", () => {
  const ownership = { runId: "run-shared", resources: {} };
  assert.equal(resolveOkfV02RunOwnership({ ownership }), ownership);
});

function requireFunction(name) {
  assert.equal(
    typeof fullFlow[name],
    "function",
    `full-flow-e2e must export ${name}`
  );
  return fullFlow[name];
}

test("OKF 0.2 full-flow config names only the runtime legacy corpus variable", () => {
  const privatePath = "/private/legal-corpus";
  const config = fullFlow.readFullFlowConfig("all", {
    FOCOWIKI_FULL_FLOW_INCLUDE_BROWSER: "false",
    FOCOWIKI_FULL_FLOW_INCLUDE_REPOSITORY: "false",
    OKF_V01_COMPAT_CORPUS_DIR: privatePath
  });

  assert.equal(config.changeId, "align-google-okf-v0-2-trust-signals");
  assert.equal(config.okfV01CompatCorpusEnv, "OKF_V01_COMPAT_CORPUS_DIR");
  assert.equal(JSON.stringify(config).includes(privatePath), false);
  assert.equal(
    fullFlow.buildFullFlowPlan(config).some((step) => step.id === "okf-v02-200-file-e2e"),
    true
  );
});

test("OKF 0.2 checkout verification pins HEAD and the exact official census", () => {
  const verify = requireFunction("verifyOkfV02OfficialCheckout");
  assert.deepEqual(verify({
    expectedRevision: PINNED_REVISION,
    actualRevision: PINNED_REVISION,
    markdownPaths: [
      ...Array.from({ length: 25 }, (_, index) => `reserved-${index}.md`),
      ...Array.from({ length: 53 }, (_, index) => `concept-${index}.md`)
    ],
    reservedPaths: Array.from({ length: 25 }, (_, index) => `reserved-${index}.md`)
  }), {
    markdownCount: 78,
    reservedMarkdownCount: 25,
    uploadableConceptCount: 53
  });
  assert.throws(() => verify({
    expectedRevision: PINNED_REVISION,
    actualRevision: "wrong",
    markdownPaths: [],
    reservedPaths: []
  }), /revision/u);
});

test("OKF 0.2 legacy selection is deterministic and requires exactly 147 safe files", () => {
  const select = requireFunction("selectOkfV01CompatibilityFiles");
  const paths = Array.from({ length: 180 }, (_, index) => ({
    relativePath: `legacy/f-${String(index).padStart(3, "0")}.md`,
    checksumSha256: String(index).padStart(64, "0")
  }));
  const first = select(paths, 147);
  const second = select([...paths].reverse(), 147);

  assert.equal(first.length, 147);
  assert.deepEqual(first, second);
  assert.equal(first[0].relativePath, "legacy/f-000.md");
  assert.equal(first.at(-1).relativePath, "legacy/f-146.md");
  assert.throws(() => select(paths.slice(0, 146), 147), /147/u);
  assert.throws(() => select([
    ...paths,
    { relativePath: "../unsafe.md", checksumSha256: "a".repeat(64) }
  ], 147), /safe|path/u);
});

test("OKF 0.2 manifest contains 53 official plus 147 legacy files without mutation", () => {
  const build = requireFunction("buildOkfV02FixtureManifest");
  const official = Array.from({ length: 53 }, (_, index) => ({
    relativePath: `okf/concepts/official-${index}.md`,
    checksumSha256: "a".repeat(64),
    sizeBytes: 10
  }));
  const legacy = Array.from({ length: 147 }, (_, index) => ({
    relativePath: `legacy-${index}.md`,
    checksumSha256: "b".repeat(64),
    sizeBytes: 20
  }));
  const before = JSON.stringify({ official, legacy });
  const manifest = build({ official, legacy });

  assert.equal(manifest.entries.length, 200);
  assert.equal(manifest.entries.filter((item) => item.compatibility === "native-v02").length, 53);
  assert.equal(manifest.entries.filter((item) => item.compatibility === "legacy-v01").length, 147);
  assert.equal(manifest.entries.every((item) => item.path.startsWith("official/") || item.path.startsWith("legacy/")), true);
  assert.equal(JSON.stringify({ official, legacy }), before);
});

test("OKF 0.2 reports redact source roots and enumerate run-owned cleanup", () => {
  const summarize = requireFunction("summarizeOkfV02FixtureRun");
  const privateRoot = "/private/legal-corpus";
  const summary = summarize({
    officialCheckoutRoot: "/tmp/official-checkout",
    legacyCorpusRoot: privateRoot,
    runId: "okf-v02-run",
    ownedResources: {
      knowledgeBaseIds: ["kb-a"],
      searchIndexes: ["index-a"],
      temporaryPaths: ["/tmp/okf-v02-run"]
    }
  });
  const serialized = JSON.stringify(summary);

  assert.equal(serialized.includes(privateRoot), false);
  assert.equal(serialized.includes("/tmp/official-checkout"), false);
  assert.deepEqual(summary.sourceRoots, {
    official: "<PINNED_GOOGLE_OKF_CHECKOUT>",
    legacy: "<OKF_V01_COMPAT_CORPUS_DIR>"
  });
  assert.deepEqual(summary.cleanup.knowledgeBaseIds, ["kb-a"]);
  assert.deepEqual(summary.cleanup.searchIndexes, ["index-a"]);
  assert.deepEqual(summary.cleanup.temporaryPaths, ["<RUN_WORKSPACE>"]);
});
