import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createGraphCandidatePlanTarget } from "../src/db/query-plan-validation.js";

describe("large-scale ingestion architecture gates", () => {
  it("uses an indexed body-term projection for graph candidates", () => {
    const target = createGraphCandidatePlanTarget({
      knowledgeBaseId: "kb-plan",
      sourceFileId: "source-file-plan",
      terms: ["distributed systems", "一致性"],
      limit: 100
    });
    const sql = normalize(target.sql);

    expect(sql).toContain("source_file_graph_term_documents");
    expect(sql).toContain("lexical_vector @@");
    expect(sql).not.toContain("profile_json::text");
    expect(sql).not.toContain("source_file_graph_nodes node where");
  });

  it("bounds graph candidate work before phrase and lexical scoring", () => {
    const repository = readSource("../src/db/file-graph-repository.ts");
    const plan = readSource("../src/db/query-plan-validation.ts");

    for (const source of [repository, plan]) {
      expect(source).toContain("least(");
      expect(source).toContain("document.phrase_terms &&");
      expect(source).toContain("document.exact_terms && query.exact_terms");
      expect(source).toContain("websearch_to_tsquery('simple', query.lexical_text)");
    }
    expect(repository).toContain("SET LOCAL enable_seqscan = off");
    expect(repository).not.toContain("websearch_to_tsquery('simple', ${query.lexicalText})");
  });

  it("does not retain per-edge graph writes or repeated summary refreshes", () => {
    const source = readSource("../src/db/file-graph-repository.ts");
    const stage = readSource("../src/admin/source-file-graph-stage.ts");

    expect(source).not.toContain("for (const edge of edges)");
    expect(source).not.toContain("refreshGraphSummaries");
    expect(source).toContain("applyGraphMutationSet");
    expect(stage).not.toContain("createGraphJob");
    expect(stage).not.toContain("completeGraphJob");
  });

  it("does not assemble generations or persist impacts one at a time on source completion", () => {
    const source = readSource(
      "../src/infrastructure/postgres/publication-generation-repository.ts"
    );

    expect(source).not.toContain("for (const impact of impacts)");
    expect(source).not.toContain("SELECT count(*)::int AS count");
    expect(source).toContain("appendPublicationChangeFact");
    expect(source).toContain("FOR NO KEY UPDATE OF revision, source");
    expect(source).not.toContain("FOR UPDATE OF revision, source");
  });

  it("keeps source-stage eligibility and revision-state writes bounded", () => {
    const processor = readSource("../src/admin/source-file-processor.ts");
    const repository = readSource(
      "../src/infrastructure/postgres/source-file-repository.ts"
    );
    const revisionContext = readSource(
      "../src/infrastructure/postgres/source-revision-context-repository.ts"
    );

    expect(count(processor, "assertSourceFileProcessingEligible();")).toBeLessThanOrEqual(2);
    expect(processor).not.toContain("repositories.knowledgeBases.getKnowledgeBase");
    expect(repository).toContain("input.status === \"running\" && input.startedAt !== null");
    expect(revisionContext).toContain("JOIN focowiki.knowledge_bases knowledge_base");
  });

  it("supports bulk publication completion and continuous slot refill", () => {
    const repository = readSource(
      "../src/infrastructure/postgres/publication-impact-repository.ts"
    );
    const processor = readSource("../src/worker/publication-role-processor.ts");

    expect(repository).toContain("completeBatch");
    expect(processor).toContain("createContinuousSlotScheduler");
    expect(processor).not.toContain("groupIndex += input.workSettings.impactConcurrency");
  });

  it("groups generated projection changes into bounded reusable segments", () => {
    const writer = readSource("../src/publication/projection-segment-writer.ts");

    expect(writer).toContain("ProjectionSegment");
    expect(writer).toContain("tombstone");
    expect(writer).toContain("renderProjectionManifest");
  });

  it("keeps global pressure counts off the source dispatch hot path", () => {
    const repository = readSource(
      "../src/infrastructure/postgres/source-dispatch-repository.ts"
    );

    expect(repository).toContain("readRuntimePressureSnapshot");
    expect(repository).not.toContain("count(*) FILTER");
    expect(repository).not.toContain("SELECT count(*)::int");
    expect(repository).not.toContain("max(extract(epoch");
  });

  it("measures the 10,000-file publication capacity with the production segment writer", () => {
    const benchmark = readSource("../scripts/incremental-scale-evidence.ts");

    expect(benchmark).toContain("const LARGE_DIRTY_FILE_COUNT = 10_000");
    expect(benchmark).toContain("measureLargeDirtyPublication");
    expect(benchmark).toContain("createProjectionSegmentWriter");
    expect(benchmark).toContain("terminalActivationMs");
    expect(benchmark).toContain("objectsPerChangedFile");
  });
});

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

function count(value: string, token: string): number {
  return value.split(token).length - 1;
}

function normalize(sql: string): string {
  return sql.replace(/\s+/gu, " ").trim().toLowerCase();
}
