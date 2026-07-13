import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryPath = resolve(import.meta.dirname, "../src/db/admin-repositories.ts");

function readNormalized(path: string): string {
  return readFileSync(path, "utf8").replace(/\s+/g, " ").toLowerCase();
}

describe("knowledge base repository contract", () => {
  it("keeps filtered card search database-backed with keyset pagination", () => {
    const repository = readNormalized(repositoryPath);
    const section = repository.slice(
      repository.indexOf("async listknowledgebases"),
      repository.indexOf("async createknowledgebase")
    );

    expect(section).toContain("lower(knowledge_base.id || ' ' || knowledge_base.name");
    expect(section).toContain("knowledge_base.name");
    expect(section).toContain("coalesce(knowledge_base.description");
    expect(section).toContain("like ${containsknowledgebaselikepattern");
    expect(section).toContain("escape ${");
    expect(section).toContain("knowledge_base.deleted_at is null");
    expect(section).toContain(
      "floor(extract(epoch from knowledge_base.created_at) * 1000000)::bigint::text as cursor_timestamp"
    );
    expect(section).toContain(
      "knowledge_base.created_at < to_timestamp(${cursorvalue.createdat}::double precision / 1000000)"
    );
    expect(section).toContain(
      "knowledge_base.created_at = to_timestamp(${cursorvalue.createdat}::double precision / 1000000)"
    );
    expect(section).toContain("knowledge_base.id > ${cursorvalue.id}");
    expect(section).toContain("order by knowledge_base.created_at desc, knowledge_base.id asc");
    expect(section).toContain("limit ${limit + 1}");
    expect(section).not.toContain(" offset ");
    expect(section).not.toContain(".filter(");
  });
});
