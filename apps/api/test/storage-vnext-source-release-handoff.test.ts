import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type {
  StorageVnextGraphEdgeFact
} from "../src/storage-vnext/graph/ports.js";

type Handoff = {
  apply(input: ReturnType<typeof handoffRequest> & {
    publicationMode?: "immediate" | "semantic_final";
  }): Promise<{
    outcome: "active" | "candidate" | "deferred";
    candidatePublicId: string | null;
    releaseOperationPublicId: string | null;
  }>;
};

type HandoffFactory = (input: ReturnType<typeof createFixture>["ports"]) => Handoff;

let factory: HandoffFactory | undefined;

beforeAll(async () => {
  const modulePath = resolve(
    import.meta.dirname,
    "../src/storage-vnext/source-processing/release-handoff.ts"
  );
  const loaded = await import(/* @vite-ignore */ pathToFileURL(modulePath).href)
    .catch(() => ({})) as { createStorageVnextSourceReleaseHandoff?: HandoffFactory };
  factory = loaded.createStorageVnextSourceReleaseHandoff;
});

describe("storage vNext source-to-graph-to-release handoff", () => {
  it("replaces current graph facts before creating one knowledge-base release candidate", async () => {
    const fixture = createFixture();
    const handoff = createHandoff(fixture);

    await expect(handoff.apply(handoffRequest())).resolves.toEqual({
      outcome: "candidate",
      candidatePublicId: expect.stringMatching(/^release-candidate-[0-9a-f]{64}$/u),
      releaseOperationPublicId: expect.stringMatching(
        /^publication-operation-[0-9a-f]{64}$/u
      )
    });
    expect(fixture.events).toEqual([
      "graph",
      "read-candidate",
      "read-active",
      "enqueue-publication",
      "create"
    ]);
    expect(fixture.graph.replaceSourceFileGraph).toHaveBeenCalledWith(expect.objectContaining({
      knowledgeBaseId: "kb-source-handoff",
      sourceFilePublicId: "file-source-handoff",
      sourceRevisionPublicId: "revision-source-handoff"
    }));
    expect(fixture.releases.createCandidate).toHaveBeenCalledWith(expect.objectContaining({
      knowledgeBaseId: "kb-source-handoff",
      operationPublicId: expect.stringMatching(/^publication-operation-[0-9a-f]{64}$/u),
      expectedActiveRootPublicId: null,
      expectedActiveRevision: 0,
      changedFacts: [
        { kind: "source_file", publicId: "file-source-handoff", change: "updated" }
      ],
      dependencies: expect.arrayContaining([
        { kind: "search", publicId: "file-source-handoff", reasonCode: "search_document" },
        { kind: "graph", publicId: "file-source-handoff", reasonCode: "graph_source" }
      ]),
      idempotency: {
        key: expect.stringMatching(/^publication-[0-9a-f]{64}$/u),
        requestHash: expect.stringMatching(/^[0-9a-f]{64}$/u)
      }
    }));
    expect(fixture.workflow.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      publicId: expect.stringMatching(/^publication-operation-[0-9a-f]{64}$/u),
      knowledgeBaseId: "kb-source-handoff",
      kind: "publication",
      state: "queued",
      settingsRevisionPublicId: "settings-source-handoff",
      nextAttemptAt: "2026-08-01T00:03:30.000Z",
      checkpoint: expect.objectContaining({
        candidatePublicId: expect.stringMatching(/^release-candidate-[0-9a-f]{64}$/u),
        phase: "planning"
      })
    }));
  });

  it("adds facts to the one existing live candidate instead of creating another", async () => {
    const fixture = createFixture();
    fixture.liveCandidate = candidate("candidate-existing", "operation-release-existing");
    const handoff = createHandoff(fixture);

    await expect(handoff.apply(handoffRequest())).resolves.toEqual({
      outcome: "candidate",
      candidatePublicId: "candidate-existing",
      releaseOperationPublicId: "operation-release-existing"
    });
    expect(fixture.releases.addCandidateFacts).toHaveBeenCalledWith(expect.objectContaining({
      candidatePublicId: "candidate-existing"
    }));
    expect(fixture.releases.createCandidate).not.toHaveBeenCalled();
  });

  it("persists source graph facts but defers release and search publication for a contracted upload", async () => {
    const fixture = createFixture();
    const handoff = createHandoff(fixture);

    await expect(handoff.apply({
      ...handoffRequest(),
      publicationMode: "semantic_final"
    })).resolves.toEqual({
      outcome: "deferred",
      candidatePublicId: null,
      releaseOperationPublicId: null
    });
    expect(fixture.graph.replaceSourceFileGraph).toHaveBeenCalledOnce();
    expect(fixture.releases.getLiveCandidate).not.toHaveBeenCalled();
    expect(fixture.workflow.enqueue).not.toHaveBeenCalled();
    expect(fixture.releases.createCandidate).not.toHaveBeenCalled();
  });

  it("retains changed graph edges without repeating source-derived revision or node facts", async () => {
    const fixture = createFixture();
    const handoff = createHandoff(fixture);
    const edge: StorageVnextGraphEdgeFact = {
      publicId: "edge-source-handoff",
      knowledgeBaseId: "kb-source-handoff",
      fromNodePublicId: "node-source-handoff",
      toNodePublicId: "node-related",
      relation: "references",
      weight: 1,
      reason: null,
      evidence: [],
      revision: 1
    };

    await handoff.apply(handoffRequest([edge]));

    expect(fixture.releases.createCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        changedFacts: [
          { kind: "source_file", publicId: "file-source-handoff", change: "updated" },
          { kind: "graph_edge", publicId: "edge-source-handoff", change: "updated" }
        ]
      })
    );
  });

  it("recovers a concurrent candidate winner and appends the same stable facts", async () => {
    const fixture = createFixture();
    const winner = candidate("candidate-concurrent", "operation-release-concurrent");
    fixture.liveCandidate = winner;
    fixture.releases.createCandidate.mockRejectedValueOnce(Object.assign(
      new Error("Concurrent candidate"),
      { code: "live_candidate_exists" }
    ));
    fixture.releases.getLiveCandidate
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner);
    const handoff = createHandoff(fixture);

    await expect(handoff.apply(handoffRequest())).resolves.toEqual({
      outcome: "candidate",
      candidatePublicId: "candidate-concurrent",
      releaseOperationPublicId: "operation-release-concurrent"
    });
    expect(fixture.releases.addCandidateFacts).toHaveBeenCalledTimes(1);
    expect(fixture.releases.addCandidateFacts).toHaveBeenCalledWith(expect.objectContaining({
      candidatePublicId: "candidate-concurrent"
    }));
  });

  it("uses one stable candidate identity when the same revision handoff is replayed", async () => {
    const fixture = createFixture();
    const handoff = createHandoff(fixture);

    const first = await handoff.apply(handoffRequest());
    if (!first.candidatePublicId || !first.releaseOperationPublicId) {
      throw new Error("Immediate source handoff did not create a candidate");
    }
    fixture.liveCandidate = candidate(
      first.candidatePublicId,
      first.releaseOperationPublicId
    );
    const replay = await handoff.apply(handoffRequest());

    expect(replay).toEqual(first);
    expect(fixture.releases.createCandidate).toHaveBeenCalledTimes(1);
  });

  it("creates fresh publication work and candidate after a failed attempt", async () => {
    const fixture = createFixture();
    const handoff = createHandoff(fixture);

    const first = await handoff.apply(handoffRequest());
    fixture.liveCandidate = null;
    const second = await handoff.apply({
      ...handoffRequest(),
      operationPublicId: "operation-source-retry"
    });

    expect(second.candidatePublicId).not.toBe(first.candidatePublicId);
    expect(second.releaseOperationPublicId).not.toBe(first.releaseOperationPublicId);
    expect(fixture.workflow.enqueue).toHaveBeenCalledTimes(2);
  });
});

function createHandoff(fixture: ReturnType<typeof createFixture>): Handoff {
  expect(factory).toBeTypeOf("function");
  if (!factory) throw new Error("Storage vNext source release handoff is unavailable");
  return factory(fixture.ports);
}

function createFixture() {
  const events: string[] = [];
  let liveCandidate: ReturnType<typeof candidate> | null = null;
  const graph = {
    replaceSourceFileGraph: vi.fn(async () => {
      events.push("graph");
    })
  };
  const releases = {
    getLiveCandidate: vi.fn(async () => {
      events.push("read-candidate");
      return liveCandidate;
    }),
    getActiveRoot: vi.fn(async () => {
      events.push("read-active");
      return null;
    }),
    createCandidate: vi.fn(async (input: {
      publicId: string;
      operationPublicId: string;
      candidateRootPublicId: string;
      createdAt: string;
    }) => {
      events.push("create");
      liveCandidate = {
        ...candidate(input.publicId, input.operationPublicId),
        candidateRootPublicId: input.candidateRootPublicId,
        createdAt: input.createdAt,
        updatedAt: input.createdAt
      };
      return liveCandidate;
    }),
    addCandidateFacts: vi.fn(async () => {
      events.push("add");
      if (!liveCandidate) throw new Error("Missing live candidate fixture");
      return liveCandidate;
    })
  };
  const workflow = {
    enqueue: vi.fn(async (work) => {
      events.push("enqueue-publication");
      return { type: "live" as const, work };
    })
  };
  return {
    events,
    graph,
    releases,
    get liveCandidate() {
      return liveCandidate;
    },
    set liveCandidate(value) {
      liveCandidate = value;
    },
    workflow,
    ports: {
      graph,
      releases,
      workflow,
      publicationDelayMilliseconds: 30_000,
      resultRetentionMilliseconds: 604_800_000
    }
  };
}

function handoffRequest(edges: StorageVnextGraphEdgeFact[] = []) {
  return {
    operationPublicId: "operation-source-handoff",
    knowledgeBaseId: "kb-source-handoff",
    settingsRevisionPublicId: "settings-source-handoff",
    sourceFile: {
      publicId: "file-source-handoff",
      knowledgeBaseId: "kb-source-handoff",
      directoryPublicId: null,
      logicalPath: "Guides/Handoff.md",
      normalizedPath: "guides/handoff.md",
      title: "Handoff",
      metadata: {},
      currentRevisionPublicId: "revision-source-handoff",
      status: "processing" as const,
      safeErrorCode: null,
      safeErrorMessage: null,
      revision: 2,
      visibility: "current" as const
    },
    sourceRevisionPublicId: "revision-source-handoff",
    node: {
      publicId: "node-source-handoff",
      knowledgeBaseId: "kb-source-handoff",
      sourceFilePublicId: "file-source-handoff",
      sourceRevisionPublicId: "revision-source-handoff",
      logicalPath: "Guides/Handoff.md",
      label: "Handoff",
      kind: "document",
      metadata: {},
      evidence: [],
      revision: 1
    },
    edges,
    completedAt: "2026-08-01T00:03:00.000Z"
  };
}

function candidate(publicId: string, operationPublicId: string) {
  return {
    publicId,
    knowledgeBaseId: "kb-source-handoff",
    operationPublicId,
    candidateRootPublicId: `root-${publicId}`,
    expectedActiveRootPublicId: null,
    expectedActiveRevision: 0,
    state: "building" as const,
    changedFactCount: 0,
    affectedDependencyCount: 0,
    manifestChecksum: null,
    createdAt: "2026-08-01T00:03:00.000Z",
    updatedAt: "2026-08-01T00:03:00.000Z"
  };
}
