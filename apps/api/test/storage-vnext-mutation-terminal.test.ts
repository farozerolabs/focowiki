import { describe, expect, it, vi } from "vitest";
import { createStorageVnextMutationTerminalCoordinator } from
  "../src/storage-vnext/mutation/mutation-terminal.js";

describe("storage vNext mutation terminal convergence", () => {
  it("cancels an accepted mutation without a release candidate", async () => {
    const fixture = terminalFixture();
    const coordinator = createStorageVnextMutationTerminalCoordinator(fixture.ports);

    await coordinator.cancelMutation(terminalRequest());

    expect(fixture.repository.terminateMutation).toHaveBeenCalledWith({
      ...terminalRequest(),
      outcome: "cancelled",
      resultCode: "MUTATION_CANCELLED",
      successorOperationPublicId: null
    });
    expect(fixture.releases.terminateCandidate).not.toHaveBeenCalled();
  });

  it("terminates the same operation's unified release/search candidate", async () => {
    const fixture = terminalFixture();
    fixture.liveCandidate = candidate("operation-terminal");
    const coordinator = createStorageVnextMutationTerminalCoordinator(fixture.ports);

    await coordinator.cancelMutation(terminalRequest());

    expect(fixture.releases.terminateCandidate).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-terminal",
      candidatePublicId: "candidate-terminal",
      outcome: "cancelled",
      reasonCode: "MUTATION_CANCELLED",
      safeMessage: null,
      eventPublicId: expect.stringMatching(/^mutation-event-[0-9a-f]{64}$/u),
      eventExpiresAt: "2026-09-01T03:00:00.000Z",
      terminatedAt: "2026-08-01T03:00:00.000Z"
    });
    expect(fixture.repository.terminateMutation).not.toHaveBeenCalled();
  });

  it("does not delete another operation's one live candidate", async () => {
    const fixture = terminalFixture();
    fixture.liveCandidate = candidate("operation-foreign");
    const coordinator = createStorageVnextMutationTerminalCoordinator(fixture.ports);

    await coordinator.cancelMutation(terminalRequest());

    expect(fixture.releases.terminateCandidate).not.toHaveBeenCalled();
    expect(fixture.repository.terminateMutation).toHaveBeenCalledTimes(1);
  });

  it("supersedes a mutation with one stable successor identity", async () => {
    const fixture = terminalFixture();
    const coordinator = createStorageVnextMutationTerminalCoordinator(fixture.ports);

    await coordinator.supersedeMutation({
      ...terminalRequest(),
      successorOperationPublicId: "operation-successor"
    });

    expect(fixture.repository.terminateMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "superseded",
        resultCode: "MUTATION_SUPERSEDED",
        successorOperationPublicId: "operation-successor"
      })
    );
  });

  it("releases a claimed mutation for bounded retry without terminal cleanup", async () => {
    const fixture = terminalFixture();
    const coordinator = createStorageVnextMutationTerminalCoordinator(fixture.ports);

    await coordinator.retryMutation({
      operationPublicId: "operation-terminal",
      owner: "mutation-worker-terminal",
      nextAttemptAt: "2026-08-01T03:05:00.000Z",
      reasonCode: "RELEASE_CANDIDATE_BUSY"
    });

    expect(fixture.workflow.releaseForRetry).toHaveBeenCalledWith({
      publicId: "operation-terminal",
      owner: "mutation-worker-terminal",
      nextAttemptAt: "2026-08-01T03:05:00.000Z",
      reasonCode: "RELEASE_CANDIDATE_BUSY"
    });
    expect(fixture.repository.terminateMutation).not.toHaveBeenCalled();
    expect(fixture.releases.terminateCandidate).not.toHaveBeenCalled();
  });
});

function terminalFixture() {
  let liveCandidate: ReturnType<typeof candidate> | null = null;
  const repository = {
    terminateMutation: vi.fn(async () => true)
  };
  const releases = {
    getLiveCandidate: vi.fn(async () => liveCandidate),
    terminateCandidate: vi.fn(async () => true)
  };
  const workflow = {
    releaseForRetry: vi.fn(async () => undefined)
  };
  return {
    repository,
    releases,
    workflow,
    get liveCandidate() {
      return liveCandidate;
    },
    set liveCandidate(value) {
      liveCandidate = value;
    },
    ports: { repository, releases, workflow }
  };
}

function terminalRequest() {
  return {
    knowledgeBaseId: "kb-terminal",
    operationPublicId: "operation-terminal",
    completedAt: "2026-08-01T03:00:00.000Z",
    resultExpiresAt: "2026-09-01T03:00:00.000Z"
  };
}

function candidate(operationPublicId: string) {
  return {
    publicId: "candidate-terminal",
    knowledgeBaseId: "kb-terminal",
    operationPublicId,
    candidateRootPublicId: "root-terminal",
    expectedActiveRootPublicId: null,
    expectedActiveRevision: 0,
    state: "building" as const,
    changedFactCount: 1,
    affectedDependencyCount: 1,
    manifestChecksum: null,
    createdAt: "2026-08-01T02:00:00.000Z",
    updatedAt: "2026-08-01T02:00:00.000Z"
  };
}
