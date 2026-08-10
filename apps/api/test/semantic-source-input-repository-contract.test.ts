import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("semantic source embedding input repository SQL", () => {
  it("projects the same C-collated expressions used by distinct ordering", () => {
    const source = readFileSync(resolve(
      import.meta.dirname,
      "../src/semantic/embedding/source-input-repository.ts"
    ), "utf8");

    expect(source).toContain(
      'SELECT DISTINCT community.public_id COLLATE "C" AS public_id, report.summary'
    );
    expect(source).toContain(
      'SELECT DISTINCT membership.community_public_id COLLATE "C" AS owner_public_id'
    );
    expect(source).toContain(
      'evidence.public_id COLLATE "C" AS evidence_public_id'
    );
  });
});
