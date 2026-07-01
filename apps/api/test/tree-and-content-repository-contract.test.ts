import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryPath = resolve(import.meta.dirname, "../src/db/admin-repositories.ts");
const developerServicePath = resolve(import.meta.dirname, "../src/developer-openapi/services.ts");

function readNormalized(path: string): string {
  return readFileSync(path, "utf8").replace(/\s+/g, " ").toLowerCase();
}

describe("tree and generated-content repository contract", () => {
  it("lists tree children with release-scoped keyset pagination and optional node type filters", () => {
    const repository = readNormalized(repositoryPath);
    const section = repository.slice(
      repository.indexOf("async listbundletreeentries"),
      repository.indexOf("async getbundlefile")
    );

    expect(section).toContain("entry.knowledge_base_id = ${knowledgebaseid}");
    expect(section).toContain("entry.release_id = ${releaseid}");
    expect(section).toContain("entry.parent_path = ${parentpath}");
    expect(section).toContain("entry.entry_type = ${entrytype}");
    expect(section).toContain("source.deleted_at is null");
    expect(section).toContain("entry.sort_key > ${cursorvalue.sortkey}");
    expect(section).toContain("order by entry.sort_key asc, entry.id asc");
    expect(section).toContain("limit ${limit + 1}");
    expect(section).not.toContain(" offset ");
  });

  it("looks up generated content by release-scoped logical path or generated file ID", () => {
    const repository = readNormalized(repositoryPath);
    const logicalPathSection = repository.slice(
      repository.indexOf("async getbundlefile"),
      repository.indexOf("async getbundlefilebyid")
    );
    const idSection = repository.slice(
      repository.indexOf("async getbundlefilebyid"),
      repository.indexOf("async getsourcefile")
    );

    expect(logicalPathSection).toContain(
      "where bundle_files.knowledge_base_id = ${knowledgebaseid}"
    );
    expect(logicalPathSection).toContain("and bundle_files.release_id = ${releaseid}");
    expect(logicalPathSection).toContain("and bundle_files.logical_path = ${logicalpath}");
    expect(logicalPathSection).toContain("source.deleted_at is null");
    expect(logicalPathSection).toContain("limit 1");
    expect(idSection).toContain("where bundle_files.knowledge_base_id = ${knowledgebaseid}");
    expect(idSection).toContain("and bundle_files.release_id = ${releaseid}");
    expect(idSection).toContain("and bundle_files.id = ${fileid}");
    expect(idSection).toContain("source.deleted_at is null");
    expect(idSection).toContain("limit 1");
  });

  it("does not fall back to paginated bundle scans for generated file ID content reads", () => {
    const service = readNormalized(developerServicePath);
    const section = service.slice(
      service.indexOf("async function resolvefilebyid"),
      service.indexOf("async function findsourcefilebyid")
    );

    expect(section).toContain("getbundlefilebyid");
    expect(section).not.toContain("listbundlefiles");
    expect(section).not.toContain("findbundlefilebyid");
  });
});
