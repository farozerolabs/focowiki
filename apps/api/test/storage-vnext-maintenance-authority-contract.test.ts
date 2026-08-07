import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { StorageVnextCurrentSourceFact } from
  "../src/storage-vnext/catalog/ports.js";
import type { StorageVnextGraphEdgeFact, StorageVnextGraphNodeFact } from
  "../src/storage-vnext/graph/ports.js";
import { renderStorageVnextPageArtifact } from
  "../src/storage-vnext/publication/rendering.js";

type SearchRebuildFactory = (input: Record<string, unknown>) => {
  runPage(input: Record<string, unknown>): Promise<Record<string, unknown>>;
};
type ProjectionRepairFactory = (input: Record<string, unknown>) => {
  runPage(input: Record<string, unknown>): Promise<Record<string, unknown>>;
};
type ObjectReconciliationFactory = (input: Record<string, unknown>) => {
  runPage(input: Record<string, unknown>): Promise<Record<string, unknown>>;
};
type PhaseRunnerFactory = (input: Record<string, unknown>) => {
  runPhase(input: Record<string, unknown>): Promise<Record<string, unknown>>;
};

let createSearchRebuild: SearchRebuildFactory | undefined;
let createProjectionRepair: ProjectionRepairFactory | undefined;
let createObjectReconciliation: ObjectReconciliationFactory | undefined;
let createPhaseRunner: PhaseRunnerFactory | undefined;

beforeAll(async () => {
  const maintenanceRoot = resolve(
    import.meta.dirname,
    "../src/storage-vnext/maintenance"
  );
  const [search, projection, reconciliation, phaseRunner] = await Promise.all([
    importOptional(`${maintenanceRoot}/search-rebuild.ts`),
    importOptional(`${maintenanceRoot}/projection-repair.ts`),
    importOptional(`${maintenanceRoot}/object-reconciliation.ts`),
    importOptional(`${maintenanceRoot}/phase-runner.ts`)
  ]);
  createSearchRebuild = search.createStorageVnextMaintenanceSearchRebuild as
    SearchRebuildFactory | undefined;
  createProjectionRepair = projection.createStorageVnextMaintenanceProjectionRepair as
    ProjectionRepairFactory | undefined;
  createObjectReconciliation = reconciliation
    .createStorageVnextMaintenanceObjectReconciliation as
      ObjectReconciliationFactory | undefined;
  createPhaseRunner = phaseRunner.createStorageVnextMaintenancePhaseRunner as
    PhaseRunnerFactory | undefined;
});

describe("storage vNext maintenance authority contract", () => {
  it("rebuilds content and graph seeds from S3 plus current PostgreSQL facts into one candidate", async () => {
    expect(createSearchRebuild).toBeTypeOf("function");
    if (!createSearchRebuild) return;
    const source = currentSource("source-maintenance", "guide.md", "# Guide\nBody");
    const node = graphNode(source);
    const written: Array<Record<string, unknown>> = [];
    const rebuild = createSearchRebuild({
      catalog: {
        listCurrentSources: vi.fn(async () => ({ items: [source], nextCursor: null }))
      },
      sourceBodies: {
        readVerifiedStream: vi.fn(async () => stream("# Guide\nBody"))
      },
      graph: {
        listNodes: vi.fn(async () => ({ items: [node], nextCursor: null }))
      },
      projection: {
        writeDocumentBatch: vi.fn(async (input: Record<string, unknown>) => {
          written.push(input);
        })
      },
      limits: {
        sourcePageSize: 10,
        graphPageSize: 10,
        maxSourceBytes: 1_024,
        maxSegmentBytes: 256,
        maxBatchDocuments: 20,
        maxBatchCompressedBytes: 8_192
      }
    });

    const sourceResult = await rebuild.runPage({
      knowledgeBaseId: "kb-maintenance-authority",
      candidatePublicId: "candidate-maintenance-authority",
      operationPublicId: "operation-maintenance-authority",
      cursor: null,
      batchOrdinal: 0
    });
    const graphResult = await rebuild.runPage({
      knowledgeBaseId: "kb-maintenance-authority",
      candidatePublicId: "candidate-maintenance-authority",
      operationPublicId: "operation-maintenance-authority",
      cursor: sourceResult.cursor,
      batchOrdinal: sourceResult.batchOrdinalDelta
    });

    const documents = written.flatMap((batch) => batch.documents as Array<{
      documentKind: string;
      sourceFilePublicId: string;
    }>);
    expect(new Set(written.map((batch) => batch.candidatePublicId))).toEqual(
      new Set(["candidate-maintenance-authority"])
    );
    expect(new Set(documents.map((document) => document.documentKind)))
      .toEqual(new Set(["content", "graph_seed"]));
    expect(documents.every((document) =>
      document.sourceFilePublicId === "source-maintenance"
    )).toBe(true);
    expect(graphResult).toMatchObject({ outcome: "phase_completed", cursor: null });
  });

  it("repairs source-backed OKF pages and graph batches only from current facts", async () => {
    expect(createProjectionRepair).toBeTypeOf("function");
    if (!createProjectionRepair) return;
    const source = currentSource("source-repair", "guides/repair.md", "# Old\nBody");
    const page = {
      pagePath: "pages/guides/repair.md",
      fileId: "source-repair",
      metadata: {
        type: "Guide",
        title: "Repair",
        description: "Current fact repair."
      },
      suggestions: null,
      graphLinks: []
    };
    const node = graphNode(source);
    const edge = graphEdge(node);
    const writePageBatch = vi.fn();
    const writeGraphBatch = vi.fn();
    const finalizeCurrentFacts = vi.fn();
    const repair = createProjectionRepair({
      pages: {
        listCurrentPages: vi.fn(async () => ({
          items: [{ source, page }],
          nextCursor: null
        }))
      },
      sourceBodies: {
        readVerifiedStream: vi.fn(async () => stream("# Old\nBody"))
      },
      graph: {
        listNodes: vi.fn(async () => ({ items: [node], nextCursor: null })),
        listEdges: vi.fn(async () => ({ items: [edge], nextCursor: null }))
      },
      writer: { writePageBatch, writeGraphBatch, finalizeCurrentFacts },
      limits: { pageSize: 10, graphPageSize: 10, maxSourceBytes: 1_024 }
    });

    let cursor: string | null = null;
    let batchOrdinal = 0;
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const result = await repair.runPage({
        knowledgeBaseId: "kb-maintenance-authority",
        candidatePublicId: "candidate-maintenance-repair",
        operationPublicId: "operation-maintenance-repair",
        cursor,
        batchOrdinal
      });
      cursor = result.cursor as string | null;
      batchOrdinal += result.batchOrdinalDelta as number;
    }

    const expected = renderStorageVnextPageArtifact({
      page,
      sourceBody: "# Old\nBody",
      ordinal: 0
    });
    expect(writePageBatch).toHaveBeenCalledWith(expect.objectContaining({
      candidatePublicId: "candidate-maintenance-repair",
      artifacts: [expected]
    }));
    expect(writeGraphBatch).toHaveBeenCalledWith(expect.objectContaining({
      nodes: [node],
      edges: []
    }));
    expect(writeGraphBatch).toHaveBeenCalledWith(expect.objectContaining({
      nodes: [],
      edges: [edge]
    }));
    expect(finalizeCurrentFacts).toHaveBeenCalledOnce();
    expect(JSON.stringify(writePageBatch.mock.calls)).not.toMatch(
      /generation|historical|legacy/iu
    );
  });

  it("reconciles provider inventory against registrations and explicit owners", async () => {
    expect(createObjectReconciliation).toBeTypeOf("function");
    if (!createObjectReconciliation) return;
    const provider = {
      listPage: vi.fn(async () => ({
        items: [{
          kind: "current",
          storageKey: "owned/source/a",
          byteCount: 10
        }],
        nextCursor: null
      })),
      headCurrent: vi.fn(async () => true)
    };
    const registrations = {
      getRegistrationsByStorageKeys: vi.fn(async () => [{
        objectId: "object-a",
        storageKey: "owned/source/a",
        checksum: "a".repeat(64),
        byteCount: 10,
        contentType: "text/markdown; charset=utf-8",
        format: "source-markdown-v1",
        state: "verified",
        writeAttemptPublicId: "write-a",
        verifiedAt: "2026-07-01T00:00:00.000Z",
        zeroOwnerSince: null,
        createdAt: "2026-07-01T00:00:00.000Z"
      }]),
      getClosure: vi.fn(async () => ({
        objectId: "object-a",
        owners: [{
          publicId: "owner-a",
          knowledgeBaseId: "kb-maintenance-authority",
          objectId: "object-a",
          kind: "active_root",
          ownerPublicId: "root-active",
          createdAt: "2026-07-01T00:00:00.000Z"
        }],
        ownerCount: 1,
        graceExpiresAt: null
      })),
      listRegistrations: vi.fn(async () => ({ items: [], nextCursor: null }))
    };
    const reconcile = createObjectReconciliation({
      enabled: true,
      provider,
      registrations,
      limit: 100,
      graceElapsedAt: "2026-08-01T00:00:00.000Z"
    });

    const providerResult = await reconcile.runPage({ cursor: null });
    const registrationResult = await reconcile.runPage({
      cursor: providerResult.cursor
    });

    expect(providerResult.findings).toEqual([]);
    expect(registrationResult).toMatchObject({
      outcome: "phase_completed",
      findings: [],
      cursor: null
    });
    expect(registrations.getClosure).toHaveBeenCalledWith("object-a");
    expect(provider.listPage).toHaveBeenCalledOnce();
  });

  it("does not read provider or registrations when reconciliation is disabled", async () => {
    expect(createObjectReconciliation).toBeTypeOf("function");
    if (!createObjectReconciliation) return;
    const provider = {
      listPage: vi.fn(),
      headCurrent: vi.fn()
    };
    const registrations = {
      getRegistrationsByStorageKeys: vi.fn(),
      getClosure: vi.fn(),
      listRegistrations: vi.fn()
    };
    const reconcile = createObjectReconciliation({
      enabled: false,
      provider,
      registrations,
      limit: 100,
      graceElapsedAt: "2026-08-01T00:00:00.000Z"
    });

    await expect(reconcile.runPage({ cursor: null })).resolves.toMatchObject({
      outcome: "phase_completed",
      findings: [],
      cursor: null,
      completedDelta: 0
    });
    expect(provider.listPage).not.toHaveBeenCalled();
    expect(provider.headCurrent).not.toHaveBeenCalled();
    expect(registrations.getRegistrationsByStorageKeys).not.toHaveBeenCalled();
    expect(registrations.listRegistrations).not.toHaveBeenCalled();
  });

  it("routes every maintenance phase through one deterministic unified candidate", async () => {
    expect(createPhaseRunner).toBeTypeOf("function");
    if (!createPhaseRunner) return;
    const candidatePublicIds: string[] = [];
    const complete = {
      outcome: "phase_completed",
      completedDelta: 0,
      expectedCount: 0,
      processedBytesDelta: 0,
      batchOrdinalDelta: 0
    };
    const recordCandidate = vi.fn(async (input: Record<string, unknown>) => {
      candidatePublicIds.push(input.candidatePublicId as string);
      return complete;
    });
    const lifecycle = vi.fn(async (input: Record<string, unknown>) => {
      candidatePublicIds.push(input.candidatePublicId as string);
      return complete;
    });
    const runner = createPhaseRunner({
      searchRebuild: { runPage: recordCandidate },
      projectionRepair: { runPage: recordCandidate },
      objectReconciliation: { runPage: vi.fn(async () => complete) },
      lifecycle: { runPhase: lifecycle }
    });
    const baseCheckpoint = {
      version: 1,
      searchProviderKind: "meilisearch" as const,
      maintenanceKind: "standard" as const,
      trigger: "manual",
      cursor: null,
      batchOrdinal: 0,
      baseResourceRevision: 7,
      completedCount: 0,
      expectedCount: 0,
      processedBytes: 0,
      startedAt: "2026-08-01T00:00:00.000Z",
      lastProgressAt: "2026-08-01T00:00:00.000Z",
      elapsedActiveMs: 0,
      maxAttempts: 3,
      resultExpiresAt: "2026-08-02T00:00:00.000Z"
    };
    const searchProjection = {
      activeRole: "active",
      candidateRole: "candidate",
      documentKinds: ["content", "graph_seed"]
    };
    for (const phase of ["planning", "search_rebuild", "projection_repair"] as const) {
      await runner.runPhase({
        knowledgeBaseId: "kb-maintenance-authority",
        operationPublicId: "operation-maintenance-authority",
        checkpoint: { ...baseCheckpoint, phase },
        searchProjection,
        signal: new AbortController().signal
      });
    }

    expect(new Set(candidatePublicIds).size).toBe(1);
    expect(candidatePublicIds[0]).toMatch(/^maintenance-candidate-[0-9a-f]{64}$/u);
    expect(lifecycle).toHaveBeenCalledWith(expect.objectContaining({
      phase: "planning",
      searchProjection: {
        activeRole: "active",
        candidateRole: "candidate",
        documentKinds: ["content", "graph_seed"]
      }
    }));
  });
});

async function importOptional(path: string): Promise<Record<string, unknown>> {
  return import(/* @vite-ignore */ pathToFileURL(path).href)
    .catch(() => ({})) as Promise<Record<string, unknown>>;
}

function currentSource(
  publicId: string,
  logicalPath: string,
  body: string
): StorageVnextCurrentSourceFact {
  const bytes = Buffer.from(body, "utf8");
  const checksum = createHash("sha256").update(bytes).digest("hex");
  return {
    sourceFile: {
      publicId,
      knowledgeBaseId: "kb-maintenance-authority",
      directoryPublicId: null,
      logicalPath,
      normalizedPath: logicalPath.toLowerCase(),
      title: "Repair",
      metadata: { type: "Guide", title: "Repair" },
      currentRevisionPublicId: `revision-${publicId}`,
      status: "ready",
      safeErrorCode: null,
      safeErrorMessage: null,
      revision: 1,
      visibility: "current"
    },
    sourceRevision: {
      publicId: `revision-${publicId}`,
      sourceFilePublicId: publicId,
      knowledgeBaseId: "kb-maintenance-authority",
      objectId: `object-${publicId}`,
      checksum,
      byteCount: bytes.byteLength,
      contentType: "text/markdown; charset=utf-8",
      createdAt: "2026-08-01T00:00:00.000Z"
    }
  };
}

function graphNode(source: StorageVnextCurrentSourceFact): StorageVnextGraphNodeFact {
  return {
    publicId: `node-${source.sourceFile.publicId}`,
    knowledgeBaseId: source.sourceFile.knowledgeBaseId,
    sourceFilePublicId: source.sourceFile.publicId,
    sourceRevisionPublicId: source.sourceRevision.publicId,
    logicalPath: `pages/${source.sourceFile.logicalPath}`,
    label: source.sourceFile.title,
    kind: "guide",
    metadata: {},
    evidence: [],
    revision: 1
  };
}

function graphEdge(node: StorageVnextGraphNodeFact): StorageVnextGraphEdgeFact {
  return {
    publicId: "edge-repair",
    knowledgeBaseId: node.knowledgeBaseId,
    fromNodePublicId: node.publicId,
    toNodePublicId: node.publicId,
    relation: "references",
    weight: 1,
    reason: "Current fact",
    evidence: [],
    revision: 1
  };
}

async function* stream(value: string): AsyncGenerator<Uint8Array> {
  yield Buffer.from(value, "utf8");
}
