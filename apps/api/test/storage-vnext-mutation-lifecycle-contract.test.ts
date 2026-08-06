import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

type MoveMutationRequest = {
  kind: "source_file_move";
  knowledgeBaseId: string;
  operationPublicId: string;
  targetPublicId: string;
  expectedResourceRevision: number;
  idempotencyKey: string;
  destinationDirectoryPublicId: string | null;
  destinationLogicalPath: string;
  settingsRevisionPublicId: string;
  createdAt: string;
  expiresAt: string;
};

type ReplacementMutationRequest = {
  kind: "source_replace";
  knowledgeBaseId: string;
  operationPublicId: string;
  targetPublicId: string;
  expectedResourceRevision: number;
  idempotencyKey: string;
  candidateRevisionPublicId: string;
  objectId: string;
  checksumSha256: string;
  byteCount: number;
  contentType: "text/markdown; charset=utf-8";
  settingsRevisionPublicId: string;
  createdAt: string;
  expiresAt: string;
};

type MutationRequest = MoveMutationRequest | ReplacementMutationRequest;

type MutationAcceptance = {
  outcome: "queued" | "replayed";
  operationPublicId: string;
  state: "queued";
};

type MutationCoordinator = {
  acceptMutation(request: MutationRequest): Promise<MutationAcceptance>;
};

type MutationCoordinatorFactory = (input: {
  repository: ReturnType<typeof createFixture>["repository"];
}) => MutationCoordinator;

let factory: MutationCoordinatorFactory | undefined;

beforeAll(async () => {
  const modulePath = resolve(
    import.meta.dirname,
    "../src/storage-vnext/mutation/mutation-coordinator.ts"
  );
  const loaded = await import(/* @vite-ignore */ pathToFileURL(modulePath).href)
    .catch(() => ({})) as {
      createStorageVnextMutationCoordinator?: MutationCoordinatorFactory;
    };
  factory = loaded.createStorageVnextMutationCoordinator;
});

describe("storage vNext mutation lifecycle contract", () => {
  it("accepts the current resource revision without changing current catalog facts", async () => {
    const fixture = createFixture();
    const coordinator = createCoordinator(fixture);

    await expect(coordinator.acceptMutation(moveRequest())).resolves.toEqual({
      outcome: "queued",
      operationPublicId: "operation-mutation-contract",
      state: "queued"
    });

    expect(fixture.repository.acceptMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedResourceRevision: 7,
        candidateLogicalPath: "Guides/Renamed.md",
        normalizedCandidatePath: "guides/renamed.md",
        requestHash: expect.stringMatching(/^[0-9a-f]{64}$/u)
      })
    );
    expect(fixture.currentPaths.get("file-mutation-contract"))
      .toBe("Guides/Current.md");
  });

  it("rejects a stale resource revision without reserving the destination", async () => {
    const fixture = createFixture();
    const coordinator = createCoordinator(fixture);

    await expect(coordinator.acceptMutation(moveRequest({
      expectedResourceRevision: 6
    }))).rejects.toMatchObject({ code: "revision_conflict" });
    expect(fixture.pathReservations.size).toBe(0);
    expect(fixture.operations.size).toBe(0);
  });

  it("rejects an identical destination as an unchanged mutation", async () => {
    const fixture = createFixture();
    const coordinator = createCoordinator(fixture);

    await expect(coordinator.acceptMutation(moveRequest({
      destinationLogicalPath: "Guides/Current.md"
    }))).rejects.toMatchObject({ code: "destination_unchanged" });
    expect(fixture.pathReservations.size).toBe(0);
  });

  it("rejects a destination reserved by a competing operation", async () => {
    const fixture = createFixture();
    fixture.pathReservations.set(
      "kb-mutation-contract\0guides/renamed.md",
      "operation-competing"
    );
    const coordinator = createCoordinator(fixture);

    await expect(coordinator.acceptMutation(moveRequest()))
      .rejects.toMatchObject({ code: "path_conflict" });
    expect(fixture.operations.size).toBe(0);
  });

  it("replays an identical idempotency key and rejects a changed request", async () => {
    const fixture = createFixture();
    const coordinator = createCoordinator(fixture);

    await expect(coordinator.acceptMutation(moveRequest())).resolves.toMatchObject({
      outcome: "queued"
    });
    await expect(coordinator.acceptMutation(moveRequest())).resolves.toEqual({
      outcome: "replayed",
      operationPublicId: "operation-mutation-contract",
      state: "queued"
    });
    await expect(coordinator.acceptMutation(moveRequest({
      destinationLogicalPath: "Guides/Changed.md"
    }))).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(fixture.operations.size).toBe(1);
  });

  it("replays a replacement when only internal candidate identities change", async () => {
    const fixture = createFixture();
    const coordinator = createCoordinator(fixture);

    await expect(coordinator.acceptMutation(replacementRequest()))
      .resolves.toMatchObject({ outcome: "queued" });
    await expect(coordinator.acceptMutation(replacementRequest({
      operationPublicId: "operation-replacement-replay",
      candidateRevisionPublicId: "revision-replacement-replay"
    }))).resolves.toEqual({
      outcome: "replayed",
      operationPublicId: "operation-mutation-contract",
      state: "queued"
    });
    await expect(coordinator.acceptMutation(replacementRequest({
      operationPublicId: "operation-replacement-changed",
      candidateRevisionPublicId: "revision-replacement-changed",
      checksumSha256: sha256("# Changed replacement\n")
    }))).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("allows exactly one concurrent operation to reserve a destination", async () => {
    const fixture = createFixture();
    const coordinator = createCoordinator(fixture);
    const attempts = await Promise.allSettled([
      coordinator.acceptMutation(moveRequest({
        operationPublicId: "operation-concurrent-a",
        idempotencyKey: "mutation-concurrent-a"
      })),
      coordinator.acceptMutation(moveRequest({
        operationPublicId: "operation-concurrent-b",
        idempotencyKey: "mutation-concurrent-b"
      }))
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled"))
      .toHaveLength(1);
    expect(attempts.filter((attempt) =>
      attempt.status === "rejected"
      && hasCode(attempt.reason, "path_conflict")))
      .toHaveLength(1);
    expect(fixture.pathReservations.get(
      "kb-mutation-contract\0guides/renamed.md"
    )).toMatch(/^operation-concurrent-[ab]$/u);
  });

  it("rejects unchanged replacement content without creating a candidate revision", async () => {
    const fixture = createFixture();
    const coordinator = createCoordinator(fixture);

    await expect(coordinator.acceptMutation(replacementRequest({
      checksumSha256: fixture.currentChecksum
    }))).rejects.toMatchObject({ code: "content_unchanged" });
    expect(fixture.candidateRevisionIds.size).toBe(0);
    expect(fixture.operations.size).toBe(0);
  });

  it.each([
    ["upload", "upload_conflict"],
    ["deletion", "deletion_conflict"],
    ["maintenance", "maintenance_conflict"]
  ] as const)(
    "rejects a mutation that overlaps live %s ownership",
    async (liveOwnerKind, expectedCode) => {
      const fixture = createFixture();
      fixture.liveOwners.set("file-mutation-contract", liveOwnerKind);
      const coordinator = createCoordinator(fixture);

      await expect(coordinator.acceptMutation(moveRequest()))
        .rejects.toMatchObject({ code: expectedCode });
      expect(fixture.pathReservations.size).toBe(0);
      expect(fixture.operations.size).toBe(0);
    }
  );
});

function createCoordinator(
  fixture: ReturnType<typeof createFixture>
): MutationCoordinator {
  expect(factory).toBeTypeOf("function");
  if (!factory) throw new Error("Storage vNext mutation coordinator is unavailable");
  return factory({ repository: fixture.repository });
}

function createFixture() {
  const operations = new Map<string, {
    requestHash: string;
    operationPublicId: string;
  }>();
  const pathReservations = new Map<string, string>();
  const currentPaths = new Map([["file-mutation-contract", "Guides/Current.md"]]);
  const currentRevisions = new Map([["file-mutation-contract", 7]]);
  const currentChecksum = sha256("# Current\n");
  const candidateRevisionIds = new Set<string>();
  const liveOwners = new Map<string, "upload" | "deletion" | "maintenance">();
  const repository = {
    acceptMutation: vi.fn(async (input: {
      kind: MutationRequest["kind"];
      knowledgeBaseId: string;
      operationPublicId: string;
      targetPublicId: string;
      expectedResourceRevision: number;
      idempotencyKey: string;
      requestHash: string;
      candidateLogicalPath?: string;
      normalizedCandidatePath?: string;
      candidateRevisionPublicId?: string;
      checksumSha256?: string;
    }): Promise<MutationAcceptance> => {
      const idempotencyIdentity = [
        input.knowledgeBaseId,
        input.idempotencyKey
      ].join("\0");
      const replay = operations.get(idempotencyIdentity);
      if (replay) {
        if (replay.requestHash !== input.requestHash) {
          throw errorWithCode("idempotency_conflict");
        }
        return {
          outcome: "replayed",
          operationPublicId: replay.operationPublicId,
          state: "queued"
        };
      }
      if (currentRevisions.get(input.targetPublicId)
        !== input.expectedResourceRevision) {
        throw errorWithCode("revision_conflict");
      }
      const liveOwner = liveOwners.get(input.targetPublicId);
      if (liveOwner) throw errorWithCode(`${liveOwner}_conflict`);
      if (input.kind === "source_file_move") {
        if (currentPaths.get(input.targetPublicId) === input.candidateLogicalPath) {
          throw errorWithCode("destination_unchanged");
        }
        const reservationIdentity = [
          input.knowledgeBaseId,
          input.normalizedCandidatePath
        ].join("\0");
        const reservation = pathReservations.get(reservationIdentity);
        if (reservation && reservation !== input.operationPublicId) {
          throw errorWithCode("path_conflict");
        }
        pathReservations.set(reservationIdentity, input.operationPublicId);
      } else {
        if (input.checksumSha256 === currentChecksum) {
          throw errorWithCode("content_unchanged");
        }
        candidateRevisionIds.add(input.candidateRevisionPublicId!);
      }
      operations.set(idempotencyIdentity, {
        requestHash: input.requestHash,
        operationPublicId: input.operationPublicId
      });
      return {
        outcome: "queued",
        operationPublicId: input.operationPublicId,
        state: "queued"
      };
    })
  };
  return {
    repository,
    operations,
    pathReservations,
    currentPaths,
    currentChecksum,
    candidateRevisionIds,
    liveOwners
  };
}

function moveRequest(
  overrides: Partial<MoveMutationRequest> = {}
): MoveMutationRequest {
  return {
    kind: "source_file_move",
    knowledgeBaseId: "kb-mutation-contract",
    operationPublicId: "operation-mutation-contract",
    targetPublicId: "file-mutation-contract",
    expectedResourceRevision: 7,
    idempotencyKey: "mutation-contract-key",
    destinationDirectoryPublicId: null,
    destinationLogicalPath: "Guides/Renamed.md",
    settingsRevisionPublicId: "settings-mutation-contract",
    createdAt: "2026-08-01T01:00:00.000Z",
    expiresAt: "2026-08-02T01:00:00.000Z",
    ...overrides
  };
}

function replacementRequest(
  overrides: Partial<ReplacementMutationRequest> = {}
): ReplacementMutationRequest {
  const checksumSha256 = sha256("# Replacement\n");
  return {
    kind: "source_replace",
    knowledgeBaseId: "kb-mutation-contract",
    operationPublicId: "operation-mutation-contract",
    targetPublicId: "file-mutation-contract",
    expectedResourceRevision: 7,
    idempotencyKey: "mutation-contract-key",
    candidateRevisionPublicId: "revision-mutation-contract",
    objectId: `source-sha256:${checksumSha256}`,
    checksumSha256,
    byteCount: 14,
    contentType: "text/markdown; charset=utf-8",
    settingsRevisionPublicId: "settings-mutation-contract",
    createdAt: "2026-08-01T01:00:00.000Z",
    expiresAt: "2026-08-02T01:00:00.000Z",
    ...overrides
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorWithCode(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
