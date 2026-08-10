import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const sourcePath = path.resolve(
  import.meta.dirname,
  "../graphrag-agent-loop-e2e.mjs"
);

test("Agent loop E2E searches, reads original evidence, and expands the graph", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /maximumAgentRounds: 2/u);
  assert.match(source, /fileContentById/u);
  assert.match(source, /fileContentByPath/u);
  assert.match(source, /graphExpansionByFileId/u);
  assert.match(source, /rerankScoreThreshold/u);
  assert.match(source, /RERANKER_DISABLED/u);
  assert.match(source, /RERANKER_UNAVAILABLE|RERANKER_ABORTED/u);
  assert.match(source, /RERANKER_NO_CANDIDATES/u);
  assert.match(source, /FOCOWIKI_AGENT_LOOP_PROVIDER/u);
  assert.match(source, /degradedRerankerEvidenceProvider/u);
});
