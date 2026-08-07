import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import type {
  StorageVnextCurrentSourceFact
} from "../src/storage-vnext/catalog/ports.js";
import type {
  StorageVnextGraphNodeFact
} from "../src/storage-vnext/graph/ports.js";
import {
  buildStorageVnextSearchCandidate
} from "../src/storage-vnext/search/streaming-builder.js";
import {
  createStorageVnextSearchDocumentSetChecksum
} from "../src/storage-vnext/search/document-set-checksum.js";
import {
  createStorageVnextCandidateQueryMatrix
} from "../src/storage-vnext/search/candidate-query-matrix.js";
import {
  createStorageVnextContentDocument
} from "../src/storage-vnext/search/documents.js";
import type {
  StorageVnextSearchProjectionPort
} from "../src/storage-vnext/search/ports.js";

const encoder = new TextEncoder();

function currentSource(input: {
  publicId: string;
  logicalPath: string;
  body: string;
}): StorageVnextCurrentSourceFact {
  const bytes = encoder.encode(input.body);
  const checksum = createHash("sha256").update(bytes).digest("hex");
  return {
    sourceFile: {
      publicId: input.publicId,
      knowledgeBaseId: "kb-stream",
      directoryPublicId: null,
      logicalPath: input.logicalPath,
      normalizedPath: input.logicalPath.toLowerCase(),
      title: input.publicId === "file-a" ? "Alpha" : "Beta",
      metadata: { owner: "platform", priority: 2 },
      currentRevisionPublicId: `revision-${input.publicId}`,
      status: "ready",
      safeErrorCode: null,
      safeErrorMessage: null,
      revision: 1,
      visibility: "current"
    },
    sourceRevision: {
      publicId: `revision-${input.publicId}`,
      sourceFilePublicId: input.publicId,
      knowledgeBaseId: "kb-stream",
      objectId: `source-sha256:${checksum}`,
      checksum,
      byteCount: bytes.byteLength,
      contentType: "text/markdown; charset=utf-8",
      createdAt: "2026-08-01T00:00:00.000Z"
    }
  };
}

const graphNode: StorageVnextGraphNodeFact = {
  publicId: "graph-node-a",
  knowledgeBaseId: "kb-stream",
  sourceFilePublicId: "file-a",
  sourceRevisionPublicId: "revision-file-a",
  logicalPath: "pages/guides/a.md",
  label: "Alpha dependency",
  kind: "guide",
  metadata: {
    tags: ["platform"],
    contentProfile: {
      subjects: ["deployment lifecycle"],
      keywords: ["rollback"],
      entities: ["Meilisearch"],
      explicitReferences: ["pages/guides/b.md"],
      relationshipHints: ["operations"],
      definitions: ["atomic index swap"],
      processHints: ["validate then activate"],
      versionHints: ["vNext"]
    }
  },
  evidence: [],
  revision: 1
};

describe("storage vNext streamed search candidate builder", () => {
  it("streams current PostgreSQL facts and S3 Markdown into bounded compressed batches", async () => {
    const events: string[] = [];
    const bodies = new Map([
      [
        "file-a",
        "---\ntitle: Alpha 合同指南\ndescription: deterministic validation sample\n---\n"
          + "# Alpha 合同指南\n" + "alpha body 合同验证 ".repeat(20)
      ],
      ["file-b", "# Beta\nsmall body"]
    ]);
    const sources = [...bodies].map(([publicId, body]) => currentSource({
      publicId,
      logicalPath: `guides/${publicId.at(-1)}.md`,
      body
    }));
    const listCurrentSources = vi.fn(async (input: { cursor: string | null }) => {
      events.push(`sources:${input.cursor ?? "first"}`);
      return input.cursor === null
        ? { items: [sources[0]!], nextCursor: "source-next" }
        : { items: [sources[1]!], nextCursor: null };
    });
    const readVerifiedStream = vi.fn(async (input: { objectId: string }) => {
      const publicId = input.objectId === sources[0]!.sourceRevision.objectId
        ? "file-a"
        : "file-b";
      const bytes = encoder.encode(bodies.get(publicId)!);
      return (async function* () {
        events.push(`body:${publicId}`);
        yield bytes.slice(0, 5);
        yield bytes.slice(5);
      })();
    });
    const listNodes = vi.fn(async (input: { cursor: string | null }) => {
      events.push(`graph:${input.cursor ?? "first"}`);
      return { items: [graphNode], nextCursor: null };
    });
    const written: Array<Parameters<
      StorageVnextSearchProjectionPort["writeDocumentBatch"]
    >[0]> = [];
    const writeDocumentBatch = vi.fn<
      StorageVnextSearchProjectionPort["writeDocumentBatch"]
    >(async (input) => {
      events.push(`write:${input.batchOrdinal}`);
      written.push(input);
    });

    const result = await buildStorageVnextSearchCandidate({
      knowledgeBaseId: "kb-stream",
      candidatePublicId: "candidate-stream",
      operationPublicId: "operation-stream",
      catalog: { listCurrentSources },
      sourceBodies: { readVerifiedStream },
      graph: { listNodes },
      projection: { writeDocumentBatch },
      sourcePageSize: 1,
      graphPageSize: 1,
      sourceReadConcurrency: 1,
      maxInFlightSourceBytes: 1_000,
      maxSourceBytes: 1_000,
      maxSegmentBytes: 64,
      maxBatchDocuments: 2,
      maxBatchCompressedBytes: 420
    });

    const documents = written.flatMap((batch) => batch.documents);
    const bodySegments = documents.filter((document) =>
      document.documentKind === "content"
      && document.contentKind === "segment"
      && document.sourceFilePublicId === "file-a"
    );
    expect(bodySegments.map((document) => document.searchText).join(""))
      .toBe(bodies.get("file-a"));
    expect(documents.filter((document) =>
      document.documentKind === "content"
      && document.contentKind === "file"
    )).toHaveLength(2);
    expect(documents.find((document) =>
      document.documentKind === "content"
      && document.contentKind === "file"
      && document.sourceFilePublicId === "file-a"
    )).toMatchObject({
      searchText: "owner: platform\npriority: 2"
    });
    expect(documents.filter((document) => document.documentKind === "graph_seed"))
      .toEqual([expect.objectContaining({
        sourceFilePublicId: "file-a",
        sourceRevisionPublicId: "revision-file-a",
        logicalPath: "pages/guides/a.md",
        searchText: [
          "Alpha dependency",
          "guide",
          "platform",
          "deployment lifecycle",
          "rollback",
          "Meilisearch",
          "pages/guides/b.md",
          "operations",
          "atomic index swap",
          "validate then activate",
          "vNext"
        ].join(" "),
        rankingTerms: [
          "Meilisearch",
          "atomic index swap",
          "deployment lifecycle",
          "guide",
          "operations",
          "pages/guides/b.md",
          "platform",
          "rollback",
          "vNext",
          "validate then activate"
        ]
      })]);
    expect(written.every((batch) => batch.documents.length <= 2)).toBe(true);
    expect(written.every((batch) =>
      batch.compressedBytes === gzipSync(
        Buffer.from(JSON.stringify(batch.documents), "utf8")
      ).byteLength
      && batch.compressedBytes <= 420
    )).toBe(true);
    expect(written.map((batch) => batch.batchOrdinal))
      .toEqual(written.map((_, index) => index));
    expect(written.every((batch) => /^[a-f0-9]{64}$/u.test(batch.payloadChecksum)))
      .toBe(true);
    expect(events.indexOf("write:0")).toBeLessThan(events.indexOf("sources:source-next"));
    expect(result).toMatchObject({
      sourceCount: 2,
      graphSeedCount: 1,
      documentCount: documents.length,
      batchCount: written.length,
      compressedBytes: written.reduce((total, batch) => total + batch.compressedBytes, 0),
      documentChecksum: createStorageVnextSearchDocumentSetChecksum(documents)
    });
    expect(result.queryCases.map((item) => item.kind)).toEqual([
      "exact", "title", "path", "content", "multi_term", "phrase", "typo",
      "chinese", "mixed_script", "graph_seed", "ranking"
    ]);
    expect(result.queryCases).toHaveLength(11);
    expect(result.queryCases.every((item) => item.relevantSources.length === 1))
      .toBe(true);
    const casesByKind = new Map(result.queryCases.map((item) => [item.kind, item]));
    expect(casesByKind.get("content")?.query).toBe("Alpha");
    expect(casesByKind.get("multi_term")?.query.split(" ")).toHaveLength(2);
    expect(casesByKind.get("multi_term")?.query).not.toMatch(/[0-9a-f]{32,}/u);
    expect(casesByKind.get("mixed_script")?.query).toMatch(
      /\p{Script=Han}+ [A-Za-z]{5,}/u
    );
    expect(casesByKind.get("mixed_script")?.query).not.toMatch(/[0-9a-f]{32,}/u);
    expect(casesByKind.get("typo")).toMatchObject({
      minimumRecall: 0,
      minimumNdcg: 0
    });
  });

  it("waits for each projection write before reading the next bounded page", async () => {
    let releaseWrite!: () => void;
    const blockedWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let secondPageRead = false;
    const source = currentSource({
      publicId: "file-a",
      logicalPath: "a.md",
      body: "# A\nbody"
    });
    const writeDocumentBatch = vi.fn(async () => blockedWrite);
    const completion = buildStorageVnextSearchCandidate({
      knowledgeBaseId: "kb-stream",
      candidatePublicId: "candidate-stream",
      operationPublicId: "operation-stream",
      catalog: {
        listCurrentSources: vi.fn(async (input: { cursor: string | null }) => {
          if (input.cursor !== null) secondPageRead = true;
          return input.cursor === null
            ? { items: [source], nextCursor: "next" }
            : { items: [], nextCursor: null };
        })
      },
      sourceBodies: {
        readVerifiedStream: vi.fn(async () => (async function* () {
          yield encoder.encode("# A\nbody");
        })())
      },
      graph: {
        listNodes: vi.fn(async () => ({ items: [], nextCursor: null }))
      },
      projection: { writeDocumentBatch },
      sourcePageSize: 1,
      graphPageSize: 1,
      sourceReadConcurrency: 1,
      maxInFlightSourceBytes: 1_000,
      maxSourceBytes: 1_000,
      maxSegmentBytes: 64,
      maxBatchDocuments: 1,
      maxBatchCompressedBytes: 420
    });

    await vi.waitFor(() => expect(writeDocumentBatch).toHaveBeenCalledTimes(1));
    expect(secondPageRead).toBe(false);
    releaseWrite();
    await completion;
    expect(secondPageRead).toBe(true);
  });

  it("resumes after persisted batches without changing deterministic ordinals or checksums", async () => {
    const source = currentSource({
      publicId: "file-a",
      logicalPath: "a.md",
      body: "# A\n" + "bounded content ".repeat(12)
    });
    const createInput = () => ({
      knowledgeBaseId: "kb-stream",
      candidatePublicId: "candidate-stream",
      operationPublicId: "operation-stream",
      catalog: {
        listCurrentSources: vi.fn(async () => ({
          items: [source],
          nextCursor: null
        }))
      },
      sourceBodies: {
        readVerifiedStream: vi.fn(async () => (async function* () {
          yield encoder.encode("# A\n" + "bounded content ".repeat(12));
        })())
      },
      graph: {
        listNodes: vi.fn(async () => ({ items: [graphNode], nextCursor: null }))
      },
      sourcePageSize: 1,
      graphPageSize: 1,
      sourceReadConcurrency: 1,
      maxInFlightSourceBytes: 1_000,
      maxSourceBytes: 1_000,
      maxSegmentBytes: 64,
      maxBatchDocuments: 1,
      maxBatchCompressedBytes: 420
    });
    const completeBatches: Array<Parameters<
      StorageVnextSearchProjectionPort["writeDocumentBatch"]
    >[0]> = [];
    const complete = await buildStorageVnextSearchCandidate({
      ...createInput(),
      projection: {
        writeDocumentBatch: vi.fn(async (batch) => {
          completeBatches.push(batch);
        })
      }
    });
    expect(completeBatches.length).toBeGreaterThan(2);

    const resumedBatches: typeof completeBatches = [];
    const resumed = await buildStorageVnextSearchCandidate({
      ...createInput(),
      projection: {
        writeDocumentBatch: vi.fn(async (batch) => {
          resumedBatches.push(batch);
        })
      },
      resumeFromBatchOrdinal: 2
    });

    expect(resumed).toEqual(complete);
    expect(resumedBatches).toEqual(completeBatches.slice(2));
    expect(resumedBatches[0]?.batchOrdinal).toBe(2);
  });

  it("rejects a resume ordinal beyond the deterministic batch count", async () => {
    await expect(buildStorageVnextSearchCandidate({
      knowledgeBaseId: "kb-stream",
      candidatePublicId: "candidate-stream",
      operationPublicId: "operation-stream",
      catalog: {
        listCurrentSources: vi.fn(async () => ({ items: [], nextCursor: null }))
      },
      sourceBodies: {
        readVerifiedStream: vi.fn()
      },
      graph: {
        listNodes: vi.fn(async () => ({ items: [], nextCursor: null }))
      },
      projection: {
        writeDocumentBatch: vi.fn()
      },
      sourcePageSize: 1,
      graphPageSize: 1,
      sourceReadConcurrency: 1,
      maxInFlightSourceBytes: 1_000,
      maxSourceBytes: 1_000,
      maxSegmentBytes: 64,
      maxBatchDocuments: 1,
      maxBatchCompressedBytes: 420,
      resumeFromBatchOrdinal: 1
    })).rejects.toThrow("Search candidate resume ordinal exceeds deterministic batch count");
  });

  it("uses the strongest distinct term for a mixed-script multi-term probe", () => {
    const matrix = createStorageVnextCandidateQueryMatrix();
    matrix.observe(createStorageVnextContentDocument({
      knowledgeBaseId: "kb-stream",
      sourceFilePublicId: "file-source",
      sourceRevisionPublicId: "revision-source",
      logicalPath: "pages/repeat/source.md",
      fileKind: "page",
      title: "source",
      contentKind: "segment",
      segmentOrdinal: 0,
      headingAncestors: [],
      searchText: "source 短词 非常明确的最长验证词语"
    }));

    expect(matrix.finish().find((item) => item.kind === "multi_term"))
      .toMatchObject({
        query: "source 非常明确的最长验证词语",
        minimumRecall: 1,
        minimumNdcg: 1
      });
  });

  it("prefers a source-specific numbered Han term over shared corpus text", () => {
    const matrix = createStorageVnextCandidateQueryMatrix();
    matrix.observe(createStorageVnextContentDocument({
      knowledgeBaseId: "kb-stream",
      sourceFilePublicId: "file-source",
      sourceRevisionPublicId: "revision-source",
      logicalPath: "pages/repeat/source.md",
      fileKind: "page",
      title: "Provider validation 01",
      contentKind: "segment",
      segmentOrdinal: 0,
      headingAncestors: [],
      searchText: "shared corpus text 统一搜索需要支持中文分词"
    }));
    matrix.observe(createStorageVnextContentDocument({
      knowledgeBaseId: "kb-stream",
      sourceFilePublicId: "file-source",
      sourceRevisionPublicId: "revision-source",
      logicalPath: "pages/repeat/source.md",
      fileKind: "page",
      title: "Provider validation 01",
      contentKind: "segment",
      segmentOrdinal: 1,
      headingAncestors: ["Late body evidence"],
      searchText: "late marker 搜索尾部证据-01"
    }));

    expect(matrix.finish().find((item) => item.kind === "chinese"))
      .toMatchObject({
        query: "搜索尾部证据-01",
        minimumRecall: 1,
        minimumNdcg: 1
      });
  });

  it("does not build validation probes from truncated provider tokens", () => {
    const matrix = createStorageVnextCandidateQueryMatrix();
    matrix.observe(createStorageVnextContentDocument({
      knowledgeBaseId: "kb-stream",
      sourceFilePublicId: "file-source",
      sourceRevisionPublicId: "revision-source",
      logicalPath: "pages/repeat/source.md",
      fileKind: "page",
      title: "source",
      contentKind: "segment",
      segmentOrdinal: 0,
      headingAncestors: [],
      searchText: `source ${"a".repeat(70)} stableTerm 合规`
    }));

    expect(matrix.finish().find((item) => item.kind === "multi_term"))
      .toMatchObject({ query: "source stableTerm" });
  });

  it("does not treat a provider token substring as a title anchor", () => {
    const matrix = createStorageVnextCandidateQueryMatrix();
    matrix.observe(createStorageVnextContentDocument({
      knowledgeBaseId: "kb-stream",
      sourceFilePublicId: "file-source",
      sourceRevisionPublicId: "revision-source",
      logicalPath: "pages/repeat/source.md",
      fileKind: "page",
      title: "source",
      contentKind: "segment",
      segmentOrdinal: 0,
      headingAncestors: [],
      searchText: "resources stableTerm 合规"
    }));

    expect(matrix.finish().find((item) => item.kind === "content"))
      .toMatchObject({
        query: "合规",
        minimumRecall: 1,
        minimumNdcg: 1
      });
  });

  it("uses current keyset facts without a persistent PostgreSQL search corpus", () => {
    const repository = readFileSync(resolve(
      import.meta.dirname,
      "../src/storage-vnext/catalog/postgres-repository.ts"
    ), "utf8");
    const migration = readFileSync(resolve(
      import.meta.dirname,
      "../migrations/001_storage_vnext.sql"
    ), "utf8");

    expect(repository).toContain("async listCurrentSources");
    expect(repository).toMatch(
      /JOIN focowiki\.source_file_current_revisions current_revision[\s\S]*JOIN focowiki\.source_revisions revision/u
    );
    expect(repository).toContain("LIMIT ${limit + 1}");
    expect(repository).not.toMatch(/\bOFFSET\b/u);
    expect(migration).not.toMatch(
      /CREATE TABLE focowiki\.(?:body_search_documents|body_search_terms|graph_term_documents|graph_term_frequencies|generation_search_refs)\b/u
    );
  });

  it("avoids recompressing the complete pending batch for every document", () => {
    const source = readFileSync(resolve(
      import.meta.dirname,
      "../src/storage-vnext/search/streaming-builder.ts"
    ), "utf8");
    const loop = source.slice(
      source.indexOf("for await (const document"),
      source.indexOf("await flush();", source.indexOf("for await (const document"))
    );

    expect(source).toContain("findLargestCompressedPrefix");
    expect(loop).not.toContain("describeBatch([...documents, document])");
  });
});
