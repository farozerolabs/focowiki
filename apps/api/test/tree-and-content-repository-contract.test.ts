import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryPath = resolve(
  import.meta.dirname,
  "../src/infrastructure/postgres/active-generation-read-repository.ts"
);
const treeReadModelPath = resolve(
  import.meta.dirname,
  "../src/infrastructure/postgres/active-tree-read-model.ts"
);
const routesPath = resolve(import.meta.dirname, "../src/developer-openapi/routes.ts");
const projectionWriterPath = resolve(
  import.meta.dirname,
  "../src/publication/required-projection-writer.ts"
);

function normalized(path: string): string {
  return readFileSync(path, "utf8").replace(/\s+/g, " ").toLowerCase();
}

describe("active tree and generated-content repository contract", () => {
  it("resolves one active generation inside a repeatable-read request scope", () => {
    const repository = normalized(repositoryPath);
    expect(repository).toContain("isolation level repeatable read read only");
    expect(repository).toContain("select active_generation_id");
    expect(repository).toContain("return reader(createscope(transaction, knowledgebaseid, generationid))");
  });

  it("lists and searches active tree projections with keyset pagination", () => {
    const treeReadModel = normalized(treeReadModelPath);
    expect(treeReadModel).toContain("projection_kind = 'tree'");
    expect(treeReadModel).toContain("coalesce(parent_path, '') = ${input.parentpath}");
    expect(treeReadModel).toContain("(coalesce(sort_key, ''), record_id) >");
    expect(treeReadModel).toContain("order by coalesce(sort_key, ''), record_id");
    expect(treeReadModel).toContain("limit ${input.limit + 1}");
    expect(treeReadModel).toContain("logical_path in ${sql(ancestorpaths)}");
    expect(treeReadModel).toContain("from focowiki.active_object_refs");
    expect(treeReadModel).not.toContain(" offset ");
  });

  it("looks up generated files directly by active file ID or logical path", () => {
    const repository = normalized(repositoryPath);
    expect(repository).toContain("active.file_id = ${input.fileid}");
    expect(repository).toContain("active.logical_path = ${input.path}");
    expect(repository).toContain("from focowiki.active_object_refs active");
    expect(repository).toContain("join focowiki.immutable_objects object");
    expect(repository).not.toContain("bundle_files");
  });

  it("builds the immutable Developer OpenAPI document once during registration", () => {
    const routes = normalized(routesPath);
    const registration = routes.slice(
      routes.indexOf("export function registerdeveloperopenapiroutes"),
      routes.indexOf("app.get(\"/openapi/v2/knowledge-bases\"")
    );
    expect(registration).toContain("const openapidocument = createdeveloperopenapidocument()");
    expect(registration).toContain(
      "app.get(\"/openapi/v2/openapi.json\", (context) => context.json(openapidocument))"
    );
  });

  it("writes generation-local projection records and immutable object references", () => {
    const writer = normalized(projectionWriterPath);
    expect(writer).toContain("records.stageupsert");
    expect(writer).toContain("input.references.stageupsert");
    expect(writer).toContain("impact.projectionkind === \"tree\"");
    expect(writer).toContain("impact.projectionkind === \"search\"");
    expect(writer).not.toContain("releaseid");
    expect(writer).not.toContain("bundlefile");
  });
});
