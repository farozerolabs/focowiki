import { describe, expect, it, vi } from "vitest";
import {
  createStorageVnextPublicationProcessor
} from "../src/storage-vnext/publication/processor.js";

describe("storage vNext publication processor", () => {
  it("builds content and graph seeds in one candidate before graph reconciliation and activation validation", async () => {
    const events: string[] = [];
    const generatedQueryCases = [{
      kind: "exact" as const,
      query: "Alpha",
      attributesToSearchOn: ["title"],
      documentKind: "content" as const,
      limit: 10,
      relevantSources: [{ sourceFilePublicId: "file-alpha", relevance: 3 }],
      minimumRecall: 1,
      minimumNdcg: 1
    }];
    const search = {
      prepareCandidate: vi.fn(async () => { events.push("search:prepare"); }),
      validateCandidate: vi.fn(async () => { events.push("search:validate"); })
    };
    const searchBuilder = {
      build: vi.fn(async () => {
        events.push("search:build");
        return {
          sourceCount: 2,
          graphSeedCount: 2,
          documentCount: 8,
          batchCount: 2,
          compressedBytes: 512,
          documentChecksum: "c".repeat(64),
          queryCases: generatedQueryCases
        };
      })
    };
    const graph = {
      reconcile: vi.fn(async () => { events.push("graph:reconcile"); })
    };
    const artifacts = {
      publish: vi.fn(async () => { events.push("artifacts:publish"); })
    };
    const releases = {
      getCandidate: vi.fn(async () => ({
        state: "building" as const,
        updatedAt: "2026-08-02T00:00:00.000Z",
        factRevision: 4
      })),
      validate: vi.fn(async () => { events.push("release:validate"); })
    };
    const processor = createStorageVnextPublicationProcessor({
      selectedSearchProviderKind: "meilisearch",
      activeSearchProjections: {
        getActiveProjection: vi.fn(async () => null)
      },
      search,
      searchBuilder,
      graph,
      artifacts,
      releases,
      schemaChecksum: "a".repeat(64),
      settingsChecksum: "b".repeat(64),
      queryCases: [],
      maxP95ProcessingTimeMs: 1_000
    });
    const signal = new AbortController().signal;

    await expect(processor.publish({
      knowledgeBaseId: "kb-one",
      candidatePublicId: "candidate-one",
      operationPublicId: "publication-one",
      signal
    })).resolves.toEqual({ searchProjectionPublicId: "candidate-one" });

    expect(events).toEqual([
      "search:prepare",
      "search:build",
      "graph:reconcile",
      "artifacts:publish",
      "search:validate",
      "release:validate"
    ]);
    expect(search.prepareCandidate).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-one",
      candidatePublicId: "candidate-one",
      schemaChecksum: "a".repeat(64),
      settingsChecksum: "b".repeat(64)
    });
    expect(graph.reconcile).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-one",
      candidatePublicId: "candidate-one",
      operationPublicId: "publication-one",
      searchProjectionPublicId: "candidate-one",
      signal
    });
    expect(search.validateCandidate).toHaveBeenCalledWith(expect.objectContaining({
      candidatePublicId: "candidate-one",
      expectedDocumentCount: 8,
      documentChecksum: "c".repeat(64),
      queryCases: generatedQueryCases
    }));
    expect(releases.validate).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-one",
      candidatePublicId: "candidate-one",
      searchProjectionPublicId: "candidate-one",
      expectedCandidateFactRevision: 4
    });
    expect(releases.getCandidate).toHaveBeenCalledTimes(2);
  });

  it("stops at an aborted boundary before publishing generated artifacts", async () => {
    const controller = new AbortController();
    const artifacts = { publish: vi.fn(async () => undefined) };
    const processor = createStorageVnextPublicationProcessor({
      selectedSearchProviderKind: "meilisearch",
      activeSearchProjections: {
        getActiveProjection: vi.fn(async () => null)
      },
      search: {
        prepareCandidate: vi.fn(async () => undefined),
        validateCandidate: vi.fn(async () => undefined)
      },
      searchBuilder: {
        build: vi.fn(async () => ({
          sourceCount: 1,
          graphSeedCount: 1,
          documentCount: 2,
          batchCount: 1,
          compressedBytes: 100,
          documentChecksum: "c".repeat(64),
          queryCases: []
        }))
      },
      graph: {
        reconcile: vi.fn(async () => { controller.abort(); })
      },
      artifacts,
      releases: {
        getCandidate: vi.fn(async () => ({
          state: "building" as const,
          updatedAt: "2026-08-02T00:00:00.000Z",
          factRevision: 4
        })),
        validate: vi.fn(async () => undefined)
      },
      schemaChecksum: "a".repeat(64),
      settingsChecksum: "b".repeat(64),
      queryCases: [],
      maxP95ProcessingTimeMs: 1_000
    });

    await expect(processor.publish({
      knowledgeBaseId: "kb-one",
      candidatePublicId: "candidate-one",
      operationPublicId: "publication-one",
      signal: controller.signal
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(artifacts.publish).not.toHaveBeenCalled();
  });

  it("rechecks late readiness after artifact assembly and before freezing the candidate", async () => {
    const readiness = vi.fn(async () => ({ state: "pending" as const }));
    const releases = {
      getCandidate: vi.fn(async () => ({
        state: "building" as const,
        updatedAt: "2026-08-02T00:00:00.000Z",
        factRevision: 4
      })),
      validate: vi.fn(async () => undefined)
    };
    const processor = createStorageVnextPublicationProcessor({
      selectedSearchProviderKind: "meilisearch",
      activeSearchProjections: {
        getActiveProjection: vi.fn(async () => null)
      },
      search: {
        prepareCandidate: vi.fn(async () => undefined),
        validateCandidate: vi.fn(async () => undefined)
      },
      searchBuilder: {
        build: vi.fn(async () => ({
          sourceCount: 0,
          graphSeedCount: 0,
          documentCount: 0,
          batchCount: 0,
          compressedBytes: 0,
          documentChecksum: "c".repeat(64),
          queryCases: []
        }))
      },
      graph: { reconcile: vi.fn(async () => undefined) },
      artifacts: { publish: vi.fn(async () => undefined) },
      releases,
      schemaChecksum: "a".repeat(64),
      settingsChecksum: "b".repeat(64),
      queryCases: [],
      maxP95ProcessingTimeMs: 1_000
    });
    const request = {
      knowledgeBaseId: "kb-one",
      candidatePublicId: "candidate-one",
      operationPublicId: "publication-one",
      signal: new AbortController().signal,
      beforeValidate: readiness
    };

    await expect(processor.publish(request)).resolves.toEqual({ state: "pending" });

    expect(readiness).toHaveBeenCalledOnce();
    expect(releases.validate).not.toHaveBeenCalled();
  });

  it("resumes release validation without rewriting a frozen candidate", async () => {
    const search = {
      prepareCandidate: vi.fn(),
      validateCandidate: vi.fn()
    };
    const searchBuilder = { build: vi.fn() };
    const graph = { reconcile: vi.fn() };
    const artifacts = { publish: vi.fn() };
    const releases = {
      getCandidate: vi.fn(async () => ({
        state: "validating" as const,
        updatedAt: "2026-08-02T00:00:00.000Z",
        factRevision: 4
      })),
      validate: vi.fn(async () => undefined)
    };
    const processor = createStorageVnextPublicationProcessor({
      selectedSearchProviderKind: "meilisearch",
      activeSearchProjections: {
        getActiveProjection: vi.fn(async () => null)
      },
      search,
      searchBuilder,
      graph,
      artifacts,
      releases,
      schemaChecksum: "a".repeat(64),
      settingsChecksum: "b".repeat(64),
      queryCases: [],
      maxP95ProcessingTimeMs: 1_000
    });

    await expect(processor.publish({
      knowledgeBaseId: "kb-one",
      candidatePublicId: "candidate-one",
      operationPublicId: "publication-one",
      signal: new AbortController().signal
    })).resolves.toEqual({ searchProjectionPublicId: "candidate-one" });

    expect(releases.validate).toHaveBeenCalledOnce();
    expect(search.prepareCandidate).not.toHaveBeenCalled();
    expect(searchBuilder.build).not.toHaveBeenCalled();
    expect(graph.reconcile).not.toHaveBeenCalled();
    expect(artifacts.publish).not.toHaveBeenCalled();
  });

  it("publishes non-search changes without adopting a mismatched active provider", async () => {
    const search = {
      prepareCandidate: vi.fn(),
      validateCandidate: vi.fn()
    };
    const searchBuilder = { build: vi.fn() };
    const graph = { reconcile: vi.fn() };
    const artifacts = { publish: vi.fn(async () => undefined) };
    const releases = {
      getCandidate: vi.fn(async () => ({
        state: "building" as const,
        updatedAt: "2026-08-02T00:00:00.000Z",
        factRevision: 4
      })),
      validate: vi.fn(async () => undefined)
    };
    const processor = createStorageVnextPublicationProcessor({
      selectedSearchProviderKind: "opensearch",
      activeSearchProjections: {
        getActiveProjection: vi.fn(async () => ({
          publicId: "search-meilisearch-active",
          providerKind: "meilisearch" as const
        }))
      },
      search,
      searchBuilder,
      graph,
      artifacts,
      releases,
      schemaChecksum: "a".repeat(64),
      settingsChecksum: "b".repeat(64),
      queryCases: [],
      maxP95ProcessingTimeMs: 1_000
    });
    const signal = new AbortController().signal;

    await expect(processor.publish({
      knowledgeBaseId: "kb-one",
      candidatePublicId: "candidate-one",
      operationPublicId: "publication-one",
      signal
    })).resolves.toEqual({
      searchProjectionPublicId: "search-meilisearch-active"
    });

    expect(search.prepareCandidate).not.toHaveBeenCalled();
    expect(searchBuilder.build).not.toHaveBeenCalled();
    expect(search.validateCandidate).not.toHaveBeenCalled();
    expect(graph.reconcile).not.toHaveBeenCalled();
    expect(artifacts.publish).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-one",
      candidatePublicId: "candidate-one",
      operationPublicId: "publication-one",
      searchProjectionPublicId: "search-meilisearch-active",
      signal
    });
    expect(releases.validate).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-one",
      candidatePublicId: "candidate-one",
      searchProjectionPublicId: "search-meilisearch-active",
      expectedCandidateFactRevision: 4
    });
  });
});
