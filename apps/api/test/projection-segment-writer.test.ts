import { describe, expect, it, vi } from "vitest";
import { createProjectionSegmentWriter } from "../src/publication/projection-segment-writer.js";
import type {
  ProjectionSegment,
  ProjectionSegmentRepository
} from "../src/application/ports/projection-segment-repository.js";

describe("projection segment writer", () => {
  it("writes bounded delta and tombstone segments while reusing the active lineage", async () => {
    const activeBase = segment({
      id: "segment-base",
      segmentKind: "base",
      sequenceNumber: 0,
      checksumSha256: "aa".repeat(32),
      logicalPath: "_segments/search/search%2Fv1%2F0001/base-aa.json"
    });
    const attached: ProjectionSegment[] = [];
    const repository = fakeRepository({ active: [activeBase], attached });
    const staged: Array<Record<string, unknown>> = [];
    let writeIndex = 0;
    const writer = createProjectionSegmentWriter({
      segments: repository,
      references: {
        stageUpsert: vi.fn(async (value) => { staged.push(value); }),
        stageDelete: vi.fn(async () => undefined),
        findActiveByPath: vi.fn(async () => null),
        findActiveByRef: vi.fn(async () => null),
        findStagedByRef: vi.fn(async () => null)
      },
      immutableObjects: {
        write: vi.fn(async ({ body, formatVersion }) => {
          writeIndex += 1;
          return {
            checksumSha256: writeIndex.toString(16).padStart(64, "0"),
            formatVersion: formatVersion ?? 1,
            objectKey: `objects/${writeIndex}`,
            contentType: "application/json; charset=utf-8",
            sizeBytes: Buffer.byteLength(String(body)),
            createdAt: "2026-07-20T00:00:00.000Z",
            verifiedAt: "2026-07-20T00:00:00.000Z",
            reused: false
          };
        })
      },
      maxSegmentEntries: 2,
      maxSegmentBytes: 2_048,
      maxObjectBytes: 8_192
    });

    const result = await writer.applyBatch({
      knowledgeBaseId: "kb-1",
      generationId: "generation-2",
      projectionKind: "search",
      shardKey: "search/v1/0001",
      logicalPath: "_index/search/v1/0001.json",
      changes: [
        { recordId: "a", record: null },
        { recordId: "b", record: { id: "b", path: "pages/b.md" } },
        { recordId: "c", record: { id: "c", path: "pages/c.md" } },
        { recordId: "d", record: { id: "d", path: "pages/d.md" } }
      ]
    });

    expect(result).toEqual({ deleted: false, recordCount: 3, reused: false });
    expect(attached.map((item) => item.segmentKind)).toEqual(["tombstone", "delta", "delta"]);
    expect(attached.every((item) => item.entryCount <= 2)).toBe(true);
    expect(staged.filter((item) => item.refKind === "projection_segment")).toHaveLength(3);
    expect(attached.at(-1)).toMatchObject({
      formatVersion: 3
    });
    expect(attached.at(-1)?.logicalPath).toMatch(/^_segments\//);
    const manifestReference = staged.find((item) => item.refKind === "projection_manifest");
    expect(manifestReference).toMatchObject({
      logicalPath: "_index/search/v1/0001.json",
      refKey: "search:search/v1/0001"
    });
    expect(repository.initializeLineage).toHaveBeenCalledOnce();
  });

  it("does not read or rewrite the active base object for a small update", async () => {
    const repository = fakeRepository({ active: [segment({ id: "segment-base" })], attached: [] });
    const write = vi.fn(async ({
      body,
      formatVersion
    }: {
      body: string | Uint8Array;
      formatVersion?: number;
    }) => ({
      checksumSha256: "bb".repeat(32),
      formatVersion: formatVersion ?? 1,
      objectKey: "objects/delta",
      contentType: "application/json; charset=utf-8",
      sizeBytes: Buffer.byteLength(String(body)),
      createdAt: "2026-07-20T00:00:00.000Z",
      verifiedAt: "2026-07-20T00:00:00.000Z",
      reused: false
    }));
    const writer = createProjectionSegmentWriter({
      segments: repository,
      references: {
        stageUpsert: vi.fn(async () => undefined),
        stageDelete: vi.fn(async () => undefined),
        findActiveByPath: vi.fn(async () => null),
        findActiveByRef: vi.fn(async () => null),
        findStagedByRef: vi.fn(async () => null)
      },
      immutableObjects: { write },
      maxSegmentEntries: 100,
      maxSegmentBytes: 8_192,
      maxObjectBytes: 16_384
    });

    await writer.apply({
      knowledgeBaseId: "kb-1",
      generationId: "generation-2",
      projectionKind: "search",
      shardKey: "search/v1/0001",
      logicalPath: "_index/search/v1/0001.json",
      recordId: "b",
      record: { id: "b", path: "pages/b.md" }
    });

    expect(write).toHaveBeenCalledTimes(1);
    const manifest = JSON.parse(String(write.mock.calls[0]?.[0].body)) as {
      formatVersion: number;
      inlineSegments: Array<{ kind: string; records: Array<{ id: string }> }>;
    };
    expect(manifest).toMatchObject({
      formatVersion: 3,
      inlineSegments: [{ kind: "delta", records: [{ id: "b" }] }]
    });
    expect(write.mock.calls[0]?.[0].formatVersion).toBe(3);
    expect(repository.registerAndAttach).toHaveBeenCalledWith(expect.objectContaining({
      logicalPath: expect.stringMatching(/^_segments\//)
    }));
    expect(repository.listGenerationLineage).toHaveBeenCalledTimes(2);
  });

  it("preserves effective record parity across delta and tombstone objects", async () => {
    const activeBase = segment({ id: "segment-base", entryCount: 2 });
    const attached: ProjectionSegment[] = [];
    const objects: string[] = [];
    const writer = createProjectionSegmentWriter({
      segments: fakeRepository({ active: [activeBase], attached }),
      references: {
        stageUpsert: vi.fn(async () => undefined),
        stageDelete: vi.fn(async () => undefined),
        findActiveByPath: vi.fn(async () => null),
        findActiveByRef: vi.fn(async () => null),
        findStagedByRef: vi.fn(async () => null)
      },
      immutableObjects: {
        write: vi.fn(async ({ body, formatVersion }) => {
          const serialized = String(body);
          objects.push(serialized);
          return {
            checksumSha256: objects.length.toString(16).padStart(64, "0"),
            formatVersion: formatVersion ?? 1,
            objectKey: `objects/${objects.length}`,
            contentType: "application/json; charset=utf-8",
            sizeBytes: Buffer.byteLength(serialized),
            createdAt: "2026-07-20T00:00:00.000Z",
            verifiedAt: "2026-07-20T00:00:00.000Z",
            reused: false
          };
        })
      },
      maxSegmentEntries: 100,
      maxSegmentBytes: 8_192,
      maxObjectBytes: 16_384
    });

    await writer.applyBatch({
      knowledgeBaseId: "kb-1",
      generationId: "generation-2",
      projectionKind: "search",
      shardKey: "search/v1/0001",
      logicalPath: "_index/search/v1/0001.json",
      changes: [
        { recordId: "a", record: null },
        { recordId: "b", record: { id: "b", path: "pages/b-updated.md" } },
        { recordId: "c", record: { id: "c", path: "pages/c.md" } }
      ]
    });

    const effective = new Map<string, Record<string, unknown>>([
      ["a", { id: "a", path: "pages/a.md" }],
      ["b", { id: "b", path: "pages/b.md" }]
    ]);
    type ParsedManifest = {
      segments: Array<{ kind: string }>;
      inlineSegments?: Array<{
        kind: string;
        records?: Array<Record<string, unknown> & { id: string }>;
        tombstones?: string[];
      }>;
    };
    let manifest: ParsedManifest | null = null;
    for (const body of objects) {
      const parsed = JSON.parse(body) as {
        segmentKind?: string;
        records?: Array<Record<string, unknown> & { id: string }>;
        tombstones?: string[];
        segments?: Array<{ kind: string }>;
        inlineSegments?: Array<{
          kind: string;
          records?: Array<Record<string, unknown> & { id: string }>;
          tombstones?: string[];
        }>;
      };
      if (parsed.segmentKind) {
        for (const recordId of parsed.tombstones ?? []) effective.delete(recordId);
        for (const record of parsed.records ?? []) effective.set(record.id, record);
      }
      if (parsed.segments) {
        manifest = parsed as ParsedManifest;
        for (const inline of parsed.inlineSegments ?? []) {
          for (const recordId of inline.tombstones ?? []) effective.delete(recordId);
          for (const record of inline.records ?? []) effective.set(record.id, record);
        }
      }
    }
    expect([...effective.values()]).toEqual([
      { id: "b", path: "pages/b-updated.md" },
      { id: "c", path: "pages/c.md" }
    ]);
    expect((manifest as ParsedManifest | null)?.segments.map((item) => item.kind))
      .toEqual(["base", "tombstone"]);
    expect((manifest as ParsedManifest | null)?.inlineSegments?.map((item) => item.kind))
      .toEqual(["delta"]);
  });

  it("falls back to an external v2 segment when the inline manifest exceeds the byte budget", async () => {
    const active = Array.from({ length: 16 }, (_, index) => segment({
      id: `segment-base-${index}`,
      sequenceNumber: index,
      checksumSha256: index.toString(16).padStart(64, "0"),
      logicalPath: `_segments/search/search/v1/0001/base-${index}.json`
    }));
    const attached: ProjectionSegment[] = [];
    const write = vi.fn(async ({
      body,
      formatVersion
    }: {
      body: string | Uint8Array;
      formatVersion?: number;
    }) => ({
      checksumSha256: String(write.mock.calls.length).padStart(64, "0"),
      formatVersion: formatVersion ?? 1,
      objectKey: `objects/${write.mock.calls.length}`,
      contentType: "application/json; charset=utf-8",
      sizeBytes: Buffer.byteLength(String(body)),
      createdAt: "2026-07-20T00:00:00.000Z",
      verifiedAt: "2026-07-20T00:00:00.000Z",
      reused: false
    }));
    const references = {
      stageUpsert: vi.fn(async () => undefined),
      stageDelete: vi.fn(async () => undefined),
      findActiveByPath: vi.fn(async () => null),
      findActiveByRef: vi.fn(async () => null),
      findStagedByRef: vi.fn(async () => null)
    };
    const writer = createProjectionSegmentWriter({
      segments: fakeRepository({ active, attached }),
      references,
      immutableObjects: { write },
      maxSegmentEntries: 100,
      maxSegmentBytes: 2_048,
      maxObjectBytes: 8_192
    });

    await writer.apply({
      knowledgeBaseId: "kb-1",
      generationId: "generation-2",
      projectionKind: "search",
      shardKey: "search/v1/0001",
      logicalPath: "_index/search/v1/0001.json",
      recordId: "b",
      record: { id: "b", path: "pages/b.md" }
    });

    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls.map((call) => call[0].formatVersion)).toEqual([2, 2]);
    expect(references.stageUpsert).toHaveBeenCalledWith(expect.objectContaining({
      refKind: "projection_segment"
    }));
    expect(attached.at(-1)?.logicalPath).toMatch(/^_segments\//);
  });

  it("stores a bounded oversized singleton instead of failing the whole generation", async () => {
    const attached: ProjectionSegment[] = [];
    const writes: string[] = [];
    const writer = createProjectionSegmentWriter({
      segments: fakeRepository({ active: [], attached }),
      references: {
        stageUpsert: vi.fn(async () => undefined),
        stageDelete: vi.fn(async () => undefined),
        findActiveByPath: vi.fn(async () => null),
        findActiveByRef: vi.fn(async () => null),
        findStagedByRef: vi.fn(async () => null)
      },
      immutableObjects: {
        write: vi.fn(async ({ body, formatVersion }) => {
          const serialized = String(body);
          writes.push(serialized);
          return {
            checksumSha256: writes.length.toString(16).padStart(64, "0"),
            formatVersion: formatVersion ?? 1,
            objectKey: `objects/${writes.length}`,
            contentType: "application/json; charset=utf-8",
            sizeBytes: Buffer.byteLength(serialized),
            createdAt: "2026-07-21T00:00:00.000Z",
            verifiedAt: "2026-07-21T00:00:00.000Z",
            reused: false
          };
        })
      },
      maxSegmentEntries: 100,
      maxSegmentBytes: 1_024,
      maxObjectBytes: 4_096
    });

    await expect(writer.apply({
      knowledgeBaseId: "kb-1",
      generationId: "generation-2",
      projectionKind: "search",
      shardKey: "search/v1/0001",
      logicalPath: "_index/search/v1/0001.json",
      recordId: "large-record",
      record: { id: "large-record", summary: "x".repeat(1_500) }
    })).resolves.toMatchObject({ recordCount: 2 });
    expect(writes.some((value) => Buffer.byteLength(value) > 1_024)).toBe(true);
    expect(writes.every((value) => Buffer.byteLength(value) <= 4_096)).toBe(true);
  });
});

function fakeRepository(input: {
  active: ProjectionSegment[];
  attached: ProjectionSegment[];
}): ProjectionSegmentRepository & {
  initializeLineage: ReturnType<typeof vi.fn>;
  listGenerationLineage: ReturnType<typeof vi.fn>;
} {
  const lineage = [...input.active];
  const initializeLineage = vi.fn(async () => undefined);
  const listGenerationLineage = vi.fn(async () => [...lineage, ...input.attached]);
  return {
    initializeLineage,
    nextSequence: vi.fn(async () => lineage.length + input.attached.length),
    registerAndAttach: vi.fn(async (value: ProjectionSegment) => {
      input.attached.push(value);
      return value;
    }),
    listGenerationLineage,
    setGenerationRecordCount: vi.fn(async () => undefined),
    countEffectiveRecords: vi.fn(async ({ changes }) => {
      const records = new Set(["a"]);
      for (const change of changes) {
        if (change.action === "delete") records.delete(change.recordId);
        else records.add(change.recordId);
      }
      return records.size;
    })
  };
}

function segment(input: Partial<ProjectionSegment> = {}): ProjectionSegment {
  return {
    id: input.id ?? "segment-1",
    knowledgeBaseId: input.knowledgeBaseId ?? "kb-1",
    projectionKind: input.projectionKind ?? "search",
    logicalPartition: input.logicalPartition ?? "search/v1/0001",
    segmentKind: input.segmentKind ?? "base",
    sequenceNumber: input.sequenceNumber ?? 0,
    formatVersion: input.formatVersion ?? 2,
    checksumSha256: input.checksumSha256 ?? "aa".repeat(32),
    objectKey: input.objectKey ?? "objects/base",
    logicalPath: input.logicalPath ?? "_segments/search/search%2Fv1%2F0001/base.json",
    entryCount: input.entryCount ?? 1,
    encodedBytes: input.encodedBytes ?? 128,
    firstRecordIdentity: input.firstRecordIdentity ?? "a",
    lastRecordIdentity: input.lastRecordIdentity ?? "a",
    baseSegmentId: input.baseSegmentId ?? null,
    lifecycleState: input.lifecycleState ?? "active"
  };
}
