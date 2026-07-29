import { describe, expect, it } from "vitest";
import {
  resolveSearchEpochActivation
} from "../src/search/search-epoch-activation.js";

describe("search epoch activation", () => {
  it("keeps released PostgreSQL search readable before cutover", () => {
    expect(resolveSearchEpochActivation({
      generationId: "generation-next",
      state: {
        routeState: "postgres_compatibility",
        pendingActivationState: "indexing",
        pendingEpoch: null,
        pendingGenerationId: null,
        pendingContentSchemaVersion: null,
        pendingGraphSchemaVersion: null,
        pendingContentSettingsChecksum: null,
        pendingGraphSettingsChecksum: null
      },
      progress: null
    })).toEqual({ outcome: "compatibility" });
  });

  it("blocks generation activation until all search work succeeds", () => {
    expect(resolveSearchEpochActivation({
      generationId: "generation-next",
      state: pendingState(),
      progress: {
        total: 12,
        queued: 1,
        submitted: 0,
        retry: 0,
        succeeded: 11,
        failed: 0,
        canceled: 0,
        superseded: 0,
        activationReady: false
      }
    })).toEqual({
      outcome: "pending",
      code: "SEARCH_PROJECTION_PENDING"
    });
  });

  it("returns the immutable pending contract when cutover is ready", () => {
    expect(resolveSearchEpochActivation({
      generationId: "generation-next",
      state: pendingState(),
      progress: {
        total: 12,
        queued: 0,
        submitted: 0,
        retry: 0,
        succeeded: 12,
        failed: 0,
        canceled: 0,
        superseded: 0,
        activationReady: true
      }
    })).toEqual({
      outcome: "activate",
      epoch: 3,
      contentSchemaVersion: "content-v1",
      graphSchemaVersion: "graph-v1",
      contentSettingsChecksum: "a".repeat(64),
      graphSettingsChecksum: "b".repeat(64)
    });
  });

  it("does not activate before the indexing worker enters the cutover phase", () => {
    expect(resolveSearchEpochActivation({
      generationId: "generation-next",
      state: {
        ...pendingState(),
        pendingActivationState: "indexing"
      },
      progress: {
        total: 12,
        queued: 0,
        submitted: 0,
        retry: 0,
        succeeded: 12,
        failed: 0,
        canceled: 0,
        superseded: 0,
        activationReady: true
      }
    })).toEqual({
      outcome: "pending",
      code: "SEARCH_PROJECTION_PENDING"
    });
  });

  it("does not activate a superseded pending generation", () => {
    expect(resolveSearchEpochActivation({
      generationId: "generation-newer",
      state: pendingState(),
      progress: null
    })).toEqual({
      outcome: "superseded",
      code: "SEARCH_PROJECTION_SUPERSEDED"
    });
  });

  it("fails a candidate with terminal search work", () => {
    expect(resolveSearchEpochActivation({
      generationId: "generation-next",
      state: pendingState(),
      progress: {
        total: 12,
        queued: 0,
        submitted: 0,
        retry: 0,
        succeeded: 11,
        failed: 1,
        canceled: 0,
        superseded: 0,
        activationReady: false
      }
    })).toEqual({
      outcome: "failed",
      code: "SEARCH_PROJECTION_FAILED"
    });
  });
});

function pendingState() {
  return {
    routeState: "meilisearch" as const,
    pendingActivationState: "swapping" as const,
    pendingEpoch: 3,
    pendingGenerationId: "generation-next",
    pendingContentSchemaVersion: "content-v1",
    pendingGraphSchemaVersion: "graph-v1",
    pendingContentSettingsChecksum: "a".repeat(64),
    pendingGraphSettingsChecksum: "b".repeat(64)
  };
}
