import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryPath = resolve(import.meta.dirname, "../src/db/hard-delete-repository.ts");

function readRepository(): string {
  return readFileSync(repositoryPath, "utf8").replace(/\s+/g, " ").toLowerCase();
}

describe("hard delete repository contract", () => {
  it("tracks object cleanup by job and deletes objects in bounded batches", () => {
    const repository = readRepository();

    expect(repository).toContain("hard_delete_object_deletions");
    expect(repository).toContain("trackobjectdeletions");
    expect(repository).toContain("source.object_key");
    expect(repository).toContain("revision.object_key");
    expect(repository).toContain("bundle.object_key");
    expect(repository).toContain("object_key");
    expect(repository).toContain("on conflict (job_id, object_key) do nothing");
    expect(repository).toContain("where job_id = ${input.jobid}");
    expect(repository).toContain("and deleted_at is null");
    expect(repository).toContain("limit ${input.limit}");
    expect(repository).toContain("set deleted_at = ${input.deletedat}");
  });

  it("purges database rows with bounded batch limits", () => {
    const repository = readRepository();

    expect(repository).toContain("function normalizebatchsize");
    expect(repository).toContain("async function deleteuntilempty");
    expect(repository).toContain("const batchsize = normalizebatchsize(input.batchsize)");
    expect(repository).toContain("recorddatabaseprogress");
    expect(repository).toContain("hard_delete_stage");
    expect(repository).toContain("hard_delete_cursor_json");
    expect(repository).toContain("limit ${batchsize}");
    expect(repository).toContain("limit ${input.batchsize}");
    expect(repository).not.toContain("return await sql.begin(async (transaction)");
  });

  it("purges source-file scoped rows before deleting the source file row", () => {
    const repository = readRepository();
    const sourceSection = repository.slice(
      repository.indexOf("async purgesourcefiledata"),
      repository.indexOf("async purgeknowledgebasedata")
    );

    expect(sourceSection).toContain("deletesourcefileobjecttracking");
    expect(sourceSection).toContain("deletesourcefilemarkdownlinks");
    expect(sourceSection).toContain("deletesourcefilehistoricalreleasedata");
    expect(sourceSection).toContain("deletesourcefileknowledgegraphsearchdocuments");
    expect(sourceSection).toContain("deletesourcefileknowledgegraphedges");
    expect(sourceSection).toContain("deletesourcefileknowledgegraphnodes");
    expect(sourceSection).toContain("deletesourcefileknowledgetreeentries");
    expect(sourceSection).toContain("deletesourcefilegraphedges");
    expect(sourceSection).toContain("deletesourcefilegraphjobs");
    expect(sourceSection).toContain("deletesourcefilegraphnodes");
    expect(sourceSection).toContain("deletesourcefilebundlefiles");
    expect(sourceSection).toContain("deletesourcefilemodelinvocations");
    expect(sourceSection).toContain("deletesourcefileevents");
    expect(sourceSection).toContain("deletesourcefileretryattempts");
    expect(sourceSection).toContain("deletesourcefileuploadentries");
    expect(sourceSection).toContain("deletesourcefileworkerjobs");
    expect(sourceSection).toContain("deletesourcefilerow");
    expect(repository).toContain("delete from focowiki.hard_delete_object_deletions");
    expect(repository).toContain("affected_releases as materialized");
    expect(repository).toContain("delete from focowiki.releases");
    expect(repository).toContain("delete from focowiki.knowledge_graph_search_documents");
    expect(repository).toContain("delete from focowiki.knowledge_graph_edges");
    expect(repository).toContain("delete from focowiki.knowledge_graph_nodes");
    expect(repository).toContain("delete from focowiki.knowledge_file_tree_nodes");
    expect(repository).toContain("delete from focowiki.source_file_graph_edges");
    expect(repository).toContain("delete from focowiki.source_file_graph_jobs");
    expect(repository).toContain("delete from focowiki.source_file_graph_nodes");
    expect(repository).toContain("delete from focowiki.bundle_files");
    expect(repository).toContain("delete from focowiki.release_markdown_links");
    expect(repository).toContain("delete from focowiki.model_invocations");
    expect(repository).toContain("delete from focowiki.source_file_events");
    expect(repository).toContain("delete from focowiki.worker_jobs");
    expect(repository).toContain("and id <> ${input.jobid}");
    expect(repository).toContain("delete from focowiki.source_files");
    expect(repository).not.toContain("delete from focowiki.source_revisions");
  });

  it("purges knowledge-base scoped rows without looping through per-file deletion", () => {
    const repository = readRepository();
    const knowledgeBaseSection = repository.slice(
      repository.indexOf("async purgeknowledgebasedata"),
      repository.indexOf("function uniquestrings")
    );

    expect(knowledgeBaseSection).toContain("update focowiki.knowledge_bases");
    expect(knowledgeBaseSection).toContain("set active_release_id = null");
    expect(knowledgeBaseSection).toContain("deleteknowledgebaseknowledgegraphinsights");
    expect(knowledgeBaseSection).toContain("deleteknowledgebaseknowledgegraphsearchdocuments");
    expect(knowledgeBaseSection).toContain("deleteknowledgebaseknowledgegraphedges");
    expect(knowledgeBaseSection).toContain("deleteknowledgebaseknowledgegraphnodes");
    expect(knowledgeBaseSection).toContain("deleteknowledgebaseknowledgetreeentries");
    expect(knowledgeBaseSection).toContain("deleteknowledgebasegraphedges");
    expect(knowledgeBaseSection).toContain("deleteknowledgebasegraphjobs");
    expect(knowledgeBaseSection).toContain("deleteknowledgebasegraphnodes");
    expect(knowledgeBaseSection).toContain("deleteknowledgebasepublicationjobs");
    expect(knowledgeBaseSection).toContain("deleteknowledgebasemarkdownlinks");
    expect(knowledgeBaseSection).toContain("deleteknowledgebasebundlefiles");
    expect(knowledgeBaseSection).toContain("deleteknowledgebasereleases");
    expect(knowledgeBaseSection).toContain("deleteknowledgebaseworkerjobs");
    expect(knowledgeBaseSection).toContain("deleteknowledgebasesourcefiles");
    expect(knowledgeBaseSection).toContain("deleteknowledgebaserow");
    expect(repository).toContain("delete from focowiki.knowledge_graph_insights");
    expect(repository).toContain("delete from focowiki.knowledge_graph_search_documents");
    expect(repository).toContain("delete from focowiki.knowledge_graph_edges");
    expect(repository).toContain("delete from focowiki.knowledge_graph_nodes");
    expect(repository).toContain("delete from focowiki.knowledge_file_tree_nodes");
    expect(repository).toContain("delete from focowiki.source_file_graph_edges");
    expect(repository).toContain("delete from focowiki.source_file_graph_jobs");
    expect(repository).toContain("delete from focowiki.source_file_graph_nodes");
    expect(repository).toContain("delete from focowiki.publication_jobs");
    expect(repository).toContain("delete from focowiki.bundle_files");
    expect(repository).toContain("delete from focowiki.releases");
    expect(repository).toContain("delete from focowiki.worker_jobs");
    expect(repository).toContain("delete from focowiki.source_files");
    expect(repository).toContain("delete from focowiki.knowledge_bases");
    expect(knowledgeBaseSection).not.toContain("purgesourcefiledata");
  });
});
