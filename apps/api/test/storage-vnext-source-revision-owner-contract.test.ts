import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositorySource = readFileSync(
  resolve(import.meta.dirname, "../src/storage-vnext/ownership/postgres-repository.ts"),
  "utf8"
);

describe("storage vNext source revision object ownership", () => {
  it("allows one source revision to own its body and derived immutable objects", () => {
    const sourceRevisionBranch = repositorySource.match(
      /if \(owner\.kind === "source_revision"\) \{([\s\S]*?)\n  \} else if/u
    )?.[1];

    expect(sourceRevisionBranch).toContain("FROM focowiki.source_revisions");
    expect(sourceRevisionBranch).toContain("public_id = ${owner.ownerPublicId}");
    expect(sourceRevisionBranch).not.toContain("object_id = ${owner.objectId}");
  });
});
