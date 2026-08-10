import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createStorageVnextMutationReleaseHandoff,
  planStorageVnextMutationCandidate
} from "../src/storage-vnext/mutation/candidate-planning.js";

describe("storage vNext mutation changed-set candidate", () => {
  it("treats a candidate without an active root as requiring a full navigation profile", () => {
    const source = readFileSync(resolve(
      import.meta.dirname,
      "../src/storage-vnext/publication/postgres-snapshot.ts"
    ), "utf8");

    expect(source).toMatch(
      /CASE\s+WHEN candidate\.expected_active_root_public_id IS NULL\s+THEN 0\s+ELSE root\.navigation_profile_version\s+END/u
    );
  });

  it("deduplicates graph-edge identities before applying collated ordering", () => {
    const source = readFileSync(resolve(
      import.meta.dirname,
      "../src/storage-vnext/mutation/postgres-candidate-preparer.ts"
    ), "utf8");

    expect(source).toMatch(
      /FROM \(\s*SELECT DISTINCT edge\.public_id[\s\S]*?\) graph_edge\s*ORDER BY graph_edge\.public_id COLLATE "C"/u
    );
  });

  it("plans knowledge-base metadata as one root-only changed set", () => {
    const plan = planStorageVnextMutationCandidate({
      knowledgeBaseId: "kb-metadata-plan",
      operationPublicId: "operation-metadata-plan",
      mutationKind: "metadata",
      targetKind: "knowledge_base",
      targetPublicId: "kb-metadata-plan",
      sourceFilePublicIds: [],
      sourceLogicalPaths: [],
      previousSourceLogicalPaths: [],
      directoryLogicalPaths: [],
      graphSourceFilePublicIds: [],
      graphEdgePublicIds: [],
      maximumChangedFacts: 10,
      maximumDependencies: 20
    });

    expect(plan.changedFacts).toEqual([{
      kind: "knowledge_base",
      publicId: "kb-metadata-plan",
      change: "updated"
    }]);
    expect(plan.unifiedSearchSourceFilePublicIds).toEqual([]);
    expect(plan.dependencies.filter((item) =>
      ["index", "schema", "log"].includes(item.kind))).toHaveLength(7);
    expect(plan.dependencies).toContainEqual({
      kind: "ancestor",
      publicId: "pages",
      reasonCode: "directory_ancestor"
    });
  });

  it("plans old and new file paths, ancestors, links, graph, and one unified search identity", () => {
    const plan = planStorageVnextMutationCandidate({
      knowledgeBaseId: "kb-mutation-plan",
      operationPublicId: "operation-mutation-plan",
      mutationKind: "move",
      targetKind: "source_file",
      targetPublicId: "file-mutation-plan",
      sourceFilePublicIds: ["file-mutation-plan"],
      sourceLogicalPaths: ["Guides/New/Move.md"],
      previousSourceLogicalPaths: ["Guides/Old/Move.md"],
      directoryLogicalPaths: ["Guides/New", "Guides/Old"],
      graphSourceFilePublicIds: ["file-related", "file-mutation-plan"],
      graphEdgePublicIds: ["edge-related"],
      maximumChangedFacts: 20,
      maximumDependencies: 100
    });

    expect(plan.changedFacts).toEqual([{
      kind: "source_file",
      publicId: "file-mutation-plan",
      change: "updated"
    }]);
    expect(plan.dependencies).toEqual(expect.arrayContaining([
      { kind: "path", publicId: "pages/Guides/New/Move.md", reasonCode: "source_path" },
      { kind: "path", publicId: "pages/Guides/Old/Move.md", reasonCode: "source_path" },
      { kind: "ancestor", publicId: "pages/Guides/New", reasonCode: "directory_ancestor" },
      { kind: "ancestor", publicId: "pages/Guides/Old", reasonCode: "directory_ancestor" },
      { kind: "link", publicId: "edge-related", reasonCode: "graph_edge" },
      { kind: "graph", publicId: "file-related", reasonCode: "graph_source" },
      { kind: "search", publicId: "file-mutation-plan", reasonCode: "search_document" },
      { kind: "index", publicId: "index.md", reasonCode: "required_navigation" },
      { kind: "schema", publicId: "schema.md", reasonCode: "required_schema" },
      { kind: "log", publicId: "log.md", reasonCode: "bounded_update_log" }
    ]));
    expect(plan.unifiedSearchSourceFilePublicIds).toEqual([
      "file-mutation-plan",
      "file-related"
    ]);
    expect(plan).not.toHaveProperty("contentSearchCandidatePublicId");
    expect(plan).not.toHaveProperty("graphSearchCandidatePublicId");
  });

  it("plans only an explicitly supplied directory subtree changed set", () => {
    const plan = planStorageVnextMutationCandidate({
      knowledgeBaseId: "kb-directory-plan",
      operationPublicId: "operation-directory-plan",
      mutationKind: "move",
      targetKind: "source_directory",
      targetPublicId: "directory-plan",
      sourceFilePublicIds: ["file-a", "file-b"],
      sourceLogicalPaths: ["Archive/A.md", "Archive/Nested/B.md"],
      previousSourceLogicalPaths: ["Guides/A.md", "Guides/Nested/B.md"],
      directoryLogicalPaths: ["Archive", "Archive/Nested", "Guides", "Guides/Nested"],
      graphSourceFilePublicIds: ["file-a", "file-b"],
      graphEdgePublicIds: [],
      maximumChangedFacts: 20,
      maximumDependencies: 100
    });

    expect(plan.changedFacts).toEqual([
      { kind: "directory", publicId: "directory-plan", change: "updated" },
      { kind: "source_file", publicId: "file-a", change: "updated" },
      { kind: "source_file", publicId: "file-b", change: "updated" }
    ]);
    expect(plan.affectedSourceFilePublicIds).toEqual(["file-a", "file-b"]);
    expect(plan.dependencies.filter((item) => item.kind === "path"))
      .toHaveLength(4);
  });

  it("creates or reuses only the candidate owned by this mutation operation", async () => {
    const fixture = releaseFixture();
    const handoff = createStorageVnextMutationReleaseHandoff(fixture.releases);
    const request = handoffRequest();

    const first = await handoff.apply(request);
    fixture.liveCandidate = {
      ...fixture.createdCandidate!,
      operationPublicId: request.operationPublicId
    };
    const replay = await handoff.apply(request);

    expect(replay).toEqual(first);
    expect(fixture.releases.createCandidate).toHaveBeenCalledTimes(1);
    expect(fixture.releases.addCandidateFacts).toHaveBeenCalledTimes(1);
    expect(first).toEqual({
      outcome: "candidate",
      candidatePublicId: expect.stringMatching(/^mutation-candidate-[0-9a-f]{64}$/u),
      releaseOperationPublicId: "operation-handoff-mutation"
    });
  });

  it("returns a retryable conflict instead of joining another operation's candidate", async () => {
    const fixture = releaseFixture();
    fixture.liveCandidate = {
      ...candidate("candidate-foreign"),
      operationPublicId: "operation-foreign"
    };
    const handoff = createStorageVnextMutationReleaseHandoff(fixture.releases);

    await expect(handoff.apply(handoffRequest()))
      .rejects.toMatchObject({ code: "release_candidate_busy" });
    expect(fixture.releases.addCandidateFacts).not.toHaveBeenCalled();
    expect(fixture.releases.createCandidate).not.toHaveBeenCalled();
  });
});

function releaseFixture() {
  let liveCandidate: ReturnType<typeof candidate> | null = null;
  let createdCandidate: ReturnType<typeof candidate> | null = null;
  const releases = {
    getLiveCandidate: vi.fn(async () => liveCandidate),
    getActiveRoot: vi.fn(async () => null),
    createCandidate: vi.fn(async (input: {
      publicId: string;
      knowledgeBaseId: string;
      operationPublicId: string;
      candidateRootPublicId: string;
      createdAt: string;
    }) => {
      createdCandidate = {
        ...candidate(input.publicId),
        knowledgeBaseId: input.knowledgeBaseId,
        operationPublicId: input.operationPublicId,
        candidateRootPublicId: input.candidateRootPublicId,
        createdAt: input.createdAt,
        updatedAt: input.createdAt
      };
      liveCandidate = createdCandidate;
      return createdCandidate;
    }),
    addCandidateFacts: vi.fn(async () => {
      if (!liveCandidate) throw new Error("Missing live candidate");
      return liveCandidate;
    })
  };
  return {
    releases,
    get liveCandidate() {
      return liveCandidate;
    },
    set liveCandidate(value) {
      liveCandidate = value;
    },
    get createdCandidate() {
      return createdCandidate;
    }
  };
}

function handoffRequest() {
  return {
    ...planStorageVnextMutationCandidate({
      knowledgeBaseId: "kb-handoff-mutation",
      operationPublicId: "operation-handoff-mutation",
      mutationKind: "rename" as const,
      targetKind: "source_file" as const,
      targetPublicId: "file-handoff-mutation",
      sourceFilePublicIds: ["file-handoff-mutation"],
      sourceLogicalPaths: ["Renamed.md"],
      previousSourceLogicalPaths: ["Current.md"],
      directoryLogicalPaths: [],
      graphSourceFilePublicIds: ["file-handoff-mutation"],
      graphEdgePublicIds: [],
      maximumChangedFacts: 20,
      maximumDependencies: 100
    }),
    idempotency: {
      key: "mutation-handoff-key",
      requestHash: "a".repeat(64)
    },
    createdAt: "2026-08-01T02:00:00.000Z"
  };
}

function candidate(publicId: string) {
  return {
    publicId,
    knowledgeBaseId: "kb-handoff-mutation",
    operationPublicId: "operation-handoff-mutation",
    candidateRootPublicId: `root-${publicId}`,
    expectedActiveRootPublicId: null,
    expectedActiveRevision: 0,
    state: "building" as const,
    factRevision: 1,
    changedFactCount: 0,
    affectedDependencyCount: 0,
    manifestChecksum: null,
    createdAt: "2026-08-01T02:00:00.000Z",
    updatedAt: "2026-08-01T02:00:00.000Z"
  };
}
