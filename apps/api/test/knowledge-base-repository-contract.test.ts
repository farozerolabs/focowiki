import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryPath = resolve(
  import.meta.dirname,
  "../src/storage-vnext/catalog/postgres-repository.ts"
);

function readNormalized(path: string): string {
  return readFileSync(path, "utf8").replace(/\s+/gu, " ").toLowerCase();
}

describe("knowledge base repository contract", () => {
  it("keeps filtered card search database-backed with opaque keyset pagination", () => {
    const repository = readNormalized(repositoryPath);
    const section = repository.slice(
      repository.indexOf("async listknowledgebases"),
      repository.indexOf("async createdirectory")
    );

    expect(section).toContain("lower(public_id || ' ' || name");
    expect(section).toContain("coalesce(description, '')");
    expect(section).toContain("strpos(");
    expect(section).toContain("public_id collate \"c\" >");
    expect(section).toContain("order by public_id collate \"c\"");
    expect(section).toContain("limit ${limit + 1}");
    expect(section).toContain("encodestoragevnextcatalogcursor");
    expect(section).not.toContain(" offset ");
    expect(section).not.toContain(".filter(");
  });
});
