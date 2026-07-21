import { describe, expect, it, vi } from "vitest";
import { createSourceFileStageRecorder } from "../src/admin/source-file-stage-recorder.js";

describe("source file stage recorder", () => {
  it("persists one complete event for a started and completed stage", async () => {
    const createEvent = vi.fn(async () => undefined);
    const recordRedisEvent = vi.fn(async () => undefined);
    const record = createSourceFileStageRecorder({
      knowledgeBaseId: "kb-stage",
      sourceFileId: "source-file-stage",
      ttlSeconds: 300,
      createEvent,
      recordRedisEvent
    });

    await record("graph_generation", {
      startedAt: "2026-07-21T00:00:00.000Z",
      endedAt: null,
      severity: "info"
    });
    expect(createEvent).not.toHaveBeenCalled();
    expect(recordRedisEvent).not.toHaveBeenCalled();

    await record("graph_generation", {
      startedAt: null,
      endedAt: "2026-07-21T00:00:01.000Z",
      severity: "warning"
    });
    expect(createEvent).toHaveBeenCalledOnce();
    expect(createEvent).toHaveBeenCalledWith(expect.objectContaining({
      stageKey: "graph_generation",
      startedAt: "2026-07-21T00:00:00.000Z",
      endedAt: "2026-07-21T00:00:01.000Z",
      severity: "warning"
    }));
    expect(recordRedisEvent).toHaveBeenCalledOnce();
  });

  it("persists a terminal event when a stage has no recorded start", async () => {
    const createEvent = vi.fn(async () => undefined);
    const recordRedisEvent = vi.fn(async () => undefined);
    const record = createSourceFileStageRecorder({
      knowledgeBaseId: "kb-stage",
      sourceFileId: "source-file-stage",
      ttlSeconds: 300,
      createEvent,
      recordRedisEvent
    });

    await record("projection_generation", {
      startedAt: null,
      endedAt: "2026-07-21T00:00:02.000Z",
      severity: "error"
    });

    expect(createEvent).toHaveBeenCalledWith(expect.objectContaining({
      stageKey: "projection_generation",
      startedAt: null,
      endedAt: "2026-07-21T00:00:02.000Z",
      severity: "error"
    }));
  });
});
