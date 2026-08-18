import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { directoryMoveRequestHash } from
  "../src/document-indexing/infrastructure/postgres-document-directory-move-support.js";

const workerSource = readFileSync(resolve(
  import.meta.dirname,
  "../src/document-indexing/infrastructure/postgres-document-directory-move.ts"
), "utf8");
const supportSource = readFileSync(resolve(
  import.meta.dirname,
  "../src/document-indexing/infrastructure/postgres-document-directory-move-support.ts"
), "utf8");

describe("document directory move contract", () => {
  it("commits the lease claim before processing and retries in a fresh transaction", () => {
    expect(workerSource).toContain("const claimed = await sql.begin");
    expect(workerSource).toMatch(/catch \(error\) \{\s+await sql\.begin/u);
    expect(workerSource).not.toMatch(
      /return sql\.begin\(async \(transaction\) => \{\s+const claimed[\s\S]*?try \{/u
    );
  });

  it("counts failures instead of successful page claims against the retry limit", () => {
    const claim = workerSource.slice(
      workerSource.indexOf("async function claimDirectoryMove"),
      workerSource.indexOf("async function moveDirectoryRows")
    );
    const retry = workerSource.slice(
      workerSource.indexOf("async function retryDirectoryMove")
    );
    expect(claim).not.toContain("attempt_count = attempt_count + 1");
    expect(retry).toContain("attempt_count = attempt_count + 1");
  });

  it("checks mapped descendant directory and file paths before acceptance", () => {
    const availability = supportSource.slice(
      supportSource.indexOf("async function assertDestinationAvailable"),
      supportSource.indexOf("function validateAcceptance")
    );
    expect(availability).toContain("WITH RECURSIVE moving_directories");
    expect(availability).toContain("mapped_directories");
    expect(availability).toContain("mapped_files");
    expect(availability).toContain("outside_directory.normalized_path = mapped.normalized_path");
    expect(availability).toContain("outside_source.normalized_path = mapped.normalized_path");
  });

  it("keeps exact request replay stable when runtime scheduling values change", () => {
    const request = {
      knowledgeBaseId: "knowledge-base-review",
      sourceDirectoryPublicId: "source-directory-review",
      destinationLogicalPath: "handbook/archive",
      destinationNormalizedPath: "handbook/archive",
      expectedResourceRevision: 1
    };
    const firstInput = {
      ...request,
      operationPublicId: "operation-first",
      acceptedAt: "2026-08-17T00:00:00.000Z"
    };
    const replayInput = {
      ...request,
      operationPublicId: "operation-replay",
      acceptedAt: "2026-08-17T00:01:00.000Z"
    };
    const first = directoryMoveRequestHash(firstInput);
    const replay = directoryMoveRequestHash(replayInput);

    expect(replay).toBe(first);
  });
});
