import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryPath = resolve(import.meta.dirname, "../src/db/admin-repositories.ts");
const developerServicePath = resolve(import.meta.dirname, "../src/developer-openapi/services.ts");
const developerRoutesPath = resolve(import.meta.dirname, "../src/developer-openapi/routes.ts");

function readNormalized(path: string): string {
  return readFileSync(path, "utf8").replace(/\s+/g, " ").toLowerCase();
}

describe("tree and generated-content repository contract", () => {
  it("lists tree children from the knowledge file tree with keyset pagination and optional node type filters", () => {
    const repository = readNormalized(repositoryPath);
    const section = repository.slice(
      repository.indexOf("async listbundletreeentries"),
      repository.indexOf("async getbundlefile")
    );

    expect(section).toContain("entry.knowledge_base_id = ${knowledgebaseid}");
    expect(section).toContain("from focowiki.knowledge_file_tree_nodes entry");
    expect(section).toContain("left join focowiki.bundle_files file");
    expect(section).toContain("entry.node_type = ${entrytype}");
    expect(section).toContain("entry.sort_key > ${cursorvalue.sortkey}");
    expect(section).toContain("order by entry.sort_key asc, entry.id asc");
    expect(section).toContain("limit ${limit + 1}");
    expect(section).toContain("entry.release_id = ${releaseid}");
    expect(section).toContain("parent.path = ${parentpath}");
    expect(section).not.toContain(" offset ");
  });

  it("searches tree entries with keyset pagination, optional node type filters, and ancestor lookup", () => {
    const repository = readNormalized(repositoryPath);
    const section = repository.slice(
      repository.indexOf("async searchbundletreeentries"),
      repository.indexOf("async getbundlefile")
    );

    expect(section).toContain("from focowiki.knowledge_file_tree_nodes entry");
    expect(section).toContain("entry.knowledge_base_id = ${knowledgebaseid}");
    expect(section).toContain("entry.node_type = ${entrytype}");
    expect(section).toContain("lower(entry.name || ' ' || entry.path)");
    expect(section).toContain("like ${searchpattern}");
    expect(section).toContain("entry.sort_key > ${cursorvalue.sortkey}");
    expect(section).toContain("order by entry.sort_key asc, entry.id asc");
    expect(section).toContain("limit ${limit + 1}");
    expect(section).toContain("entry.path = any(${ancestorpaths})");
    expect(section).not.toContain(" offset ");
  });

  it("looks up generated content by active release path or generated file ID", () => {
    const repository = readNormalized(repositoryPath);
    const logicalPathSection = repository.slice(
      repository.indexOf("async getbundlefile"),
      repository.indexOf("async getbundlefilebyid")
    );
    const idSection = repository.slice(
      repository.indexOf("async getbundlefilebyid"),
      repository.indexOf("async getsourcefile")
    );

    expect(logicalPathSection).toContain("from focowiki.bundle_files file");
    expect(logicalPathSection).toContain("file.knowledge_base_id = ${knowledgebaseid}");
    expect(logicalPathSection).toContain("file.release_id = ${releaseid}");
    expect(logicalPathSection).toContain("file.logical_path = ${logicalpath}");
    expect(logicalPathSection).toContain("limit 1");
    expect(logicalPathSection).not.toContain("join focowiki.release_source_files");
    expect(logicalPathSection).not.toContain("publication_required = true");
    expect(idSection).toContain("from focowiki.bundle_files file");
    expect(idSection).toContain("file.knowledge_base_id = ${knowledgebaseid}");
    expect(idSection).toContain("file.release_id = ${releaseid}");
    expect(idSection).toContain("file.id = ${fileid}");
    expect(idSection).toContain("limit 1");
  });

  it("does not fall back to paginated bundle scans for generated file ID content reads", () => {
    const service = readNormalized(developerServicePath);
    const section = service.slice(
      service.indexOf("async function resolvebundlefilebyid"),
      service.indexOf("async function expandgraphfromfile")
    );

    expect(section).toContain("getbundlefilebyid");
    expect(section).not.toContain("listbundlefiles");
    expect(section).not.toContain("findbundlefilebyid");
  });

  it("builds the immutable Developer OpenAPI document once during route registration", () => {
    const routes = readNormalized(developerRoutesPath);
    const registration = routes.slice(
      routes.indexOf("export function registerdeveloperopenapiroutes"),
      routes.indexOf("app.get(\"/openapi/v2/knowledge-bases\"")
    );

    expect(registration).toContain("const openapidocument = createdeveloperopenapidocument()");
    expect(registration).toContain(
      "app.get(\"/openapi/v2/openapi.json\", (context) => context.json(openapidocument))"
    );
  });

  it("persists generated files and tree entries into release-scoped projections", () => {
    const repository = readNormalized(repositoryPath);
    const filesSection = repository.slice(
      repository.indexOf("async createbundlefiles"),
      repository.indexOf("async upsertbundlefilesearchdocuments")
    );
    const treeSection = repository.slice(
      repository.indexOf("async createbundletreeentries"),
      repository.indexOf("async activaterelease")
    );

    expect(filesSection).toContain("insert into focowiki.bundle_files");
    expect(filesSection).toContain("logical_path");
    expect(filesSection).toContain("navigation_only");
    expect(filesSection).toContain("on conflict (release_id, logical_path) do nothing");
    expect(treeSection).toContain("insert into focowiki.knowledge_file_tree_nodes");
    expect(treeSection).toContain("parent_id");
    expect(treeSection).toContain("from focowiki.bundle_files file");
    expect(treeSection).toContain("file.knowledge_base_id = ${entry.knowledgebaseid}");
    expect(treeSection).toContain("and file.release_id = ${entry.releaseid}");
    expect(treeSection).toContain("and file.logical_path = ${entry.logicalpath}");
    expect(treeSection).toContain("source_directory_id");
    expect(treeSection).not.toMatch(/insert into focowiki\.bundle_\w+_entries/);
  });
});
