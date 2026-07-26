import assert from "node:assert/strict";
import test from "node:test";
import {
  readConsistentGeneratedContent
} from "../lib/active-generation-content-reader.mjs";

test("retries content reads when the active generation changes between requests", async () => {
  const generations = [
    ["generation-1", "generation-2"],
    ["generation-2", "generation-2"]
  ];
  let attempt = 0;

  const result = await readConsistentGeneratedContent({
    logicalPath: "pages/index.md",
    maxAttempts: 3,
    readById: async () => ({
      file: { fileId: "file-1", generationId: generations[attempt][0] },
      content: attempt === 0 ? "old" : "new"
    }),
    readByPath: async () => {
      const current = attempt;
      attempt += 1;
      return {
        file: { fileId: "file-1", generationId: generations[current][1] },
        content: "new"
      };
    },
    wait: async () => undefined
  });

  assert.equal(result.content, "new");
  assert.equal(result.generationId, "generation-2");
  assert.equal(attempt, 2);
});

test("rejects different content returned within the same active generation", async () => {
  await assert.rejects(
    readConsistentGeneratedContent({
      logicalPath: "pages/index.md",
      maxAttempts: 2,
      readById: async () => ({
        file: { fileId: "file-1", generationId: "generation-1" },
        content: "left"
      }),
      readByPath: async () => ({
        file: { fileId: "file-1", generationId: "generation-1" },
        content: "right"
      }),
      wait: async () => undefined
    }),
    /File content mismatch within active generation generation-1: pages\/index\.md/
  );
});

test("fails when generation changes never converge within the read budget", async () => {
  let sequence = 0;

  await assert.rejects(
    readConsistentGeneratedContent({
      logicalPath: "pages/index.md",
      maxAttempts: 2,
      readById: async () => ({
        file: { fileId: "file-1", generationId: `generation-${sequence++}` },
        content: "content"
      }),
      readByPath: async () => ({
        file: { fileId: "file-1", generationId: `generation-${sequence++}` },
        content: "content"
      }),
      wait: async () => undefined
    }),
    /Active generation did not stabilize while reading: pages\/index\.md/
  );
});
