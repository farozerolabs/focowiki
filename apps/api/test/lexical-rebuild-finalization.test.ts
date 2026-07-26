import { describe, expect, it, vi } from "vitest";
import type { LexicalRebuildClaim } from "../src/application/ports/lexical-rebuild-repository.js";
import { runLexicalRebuildFinalization } from "../src/maintenance/lexical-rebuild-finalization.js";

describe("lexical rebuild finalization", () => {
  it("validates, activates, and cleans up through bounded claimed phases", async () => {
    const phases: LexicalRebuildClaim["phase"][] = [
      "validate",
      "activate",
      "cleanup"
    ];
    const advancePhase = vi.fn(async () => undefined);
    const activate = vi.fn(async () => "activated" as const);
    const complete = vi.fn(async () => undefined);
    const cleanupUnreferencedDocuments = vi.fn(async () => 2);
    const fail = vi.fn(async () => ({
      attemptCount: 0,
      maxAttempts: 3,
      terminal: false
    }));
    const input = {
      work: {
        claimFinalization: vi.fn(async () => {
          const phase = phases.shift();
          return phase ? claim(phase) : null;
        })
      },
      rebuilds: {
        validate: vi.fn(async () => ({ passed: true, reason: null })),
        advancePhase,
        activate,
        complete,
        fail
      },
      search: { cleanupUnreferencedDocuments },
      workerId: "worker-finalization",
      leaseToken: "finalization-lease",
      now: new Date("2026-07-25T05:00:00.000Z"),
      leaseDurationMs: 60_000,
      retryDelayMs: 1_000,
      cleanupBatchSize: 50
    };

    await expect(runLexicalRebuildFinalization(input)).resolves.toBe(true);
    await expect(runLexicalRebuildFinalization(input)).resolves.toBe(true);
    await expect(runLexicalRebuildFinalization(input)).resolves.toBe(true);
    await expect(runLexicalRebuildFinalization(input)).resolves.toBe(false);

    expect(advancePhase).toHaveBeenCalledWith(expect.objectContaining({
      phase: "activate"
    }));
    expect(activate).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({
      retryDelayMs: 1_000
    }));
    expect(cleanupUnreferencedDocuments).toHaveBeenCalledWith({
      olderThan: "2026-07-24T05:00:00.000Z",
      limit: 50
    });
    expect(complete).toHaveBeenCalledOnce();
    expect(fail).not.toHaveBeenCalled();
  });

  it("records safe bounded failure evidence while preserving the active generation", async () => {
    const fail = vi.fn(async () => ({
      attemptCount: 1,
      maxAttempts: 3,
      terminal: false
    }));

    await expect(runLexicalRebuildFinalization({
      work: {
        claimFinalization: async () => claim("validate")
      },
      rebuilds: {
        validate: async () => ({
          passed: false,
          reason: "Lexical search projection parity validation failed"
        }),
        advancePhase: async () => undefined,
        activate: async () => "activated",
        complete: async () => undefined,
        fail
      },
      search: {
        cleanupUnreferencedDocuments: async () => 0
      },
      workerId: "worker-finalization",
      leaseToken: "finalization-lease",
      now: new Date("2026-07-25T05:00:00.000Z"),
      leaseDurationMs: 60_000,
      retryDelayMs: 1_000,
      cleanupBatchSize: 50
    })).resolves.toBe(true);

    expect(fail).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "LEXICAL_REBUILD_FINALIZATION_FAILED",
      errorMessage: "Lexical search projection parity validation failed"
    }));
  });
});

function claim(phase: LexicalRebuildClaim["phase"]): LexicalRebuildClaim {
  return {
    knowledgeBaseId: "kb-finalization",
    baseGenerationId: "generation-base",
    targetGenerationId: "generation-target",
    leaseRecovered: false,
    state: phase === "validate"
      ? "validating"
      : phase === "activate"
        ? "activating"
        : "running",
    phase,
    sourceCursor: null,
    processedSourceCount: 1,
    totalSourceCount: 1
  };
}
