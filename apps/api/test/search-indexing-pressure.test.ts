import { describe, expect, it } from "vitest";
import {
  createSearchIndexingPressureController
} from "../src/search/search-indexing-pressure.js";

describe("search indexing pressure", () => {
  it("holds resident-memory pressure until usage crosses the release limit", () => {
    const controller = createSearchIndexingPressureController();
    const limits = {
      queueLatencyMs: 30_000,
      residentMemoryBytes: 8_000,
      databaseSizeBytes: 100_000,
      taskQueueSizeBytes: 10_000
    };

    expect(controller.evaluate({
      queueLatencyMs: 0,
      residentMemoryBytes: 8_100,
      databaseSizeBytes: 0,
      taskQueueSizeBytes: 0
    }, limits)).toMatchObject({
      reasons: ["resident_memory"],
      releaseLimits: {
        residentMemoryBytes: 7_200
      },
      submissionPolicy: {
        allowIndexWrites: true,
        allowRoutineEngineTasks: true,
        throttleIndexWrites: true
      }
    });

    expect(controller.evaluate({
      queueLatencyMs: 0,
      residentMemoryBytes: 7_500,
      databaseSizeBytes: 0,
      taskQueueSizeBytes: 0
    }, limits)).toMatchObject({
      reasons: ["resident_memory"],
      submissionPolicy: {
        allowIndexWrites: true,
        allowRoutineEngineTasks: true,
        throttleIndexWrites: true
      }
    });

    expect(controller.evaluate({
      queueLatencyMs: 0,
      residentMemoryBytes: 7_200,
      databaseSizeBytes: 0,
      taskQueueSizeBytes: 0
    }, limits)).toMatchObject({
      reasons: [],
      submissionPolicy: {
        allowIndexWrites: true,
        allowRoutineEngineTasks: true,
        throttleIndexWrites: false
      }
    });
  });

  it("keeps cleanup-capable mutations available for capacity pressure", () => {
    const controller = createSearchIndexingPressureController();
    const decision = controller.evaluate({
      queueLatencyMs: 0,
      residentMemoryBytes: 9_000,
      databaseSizeBytes: 110_000,
      taskQueueSizeBytes: 0
    }, {
      queueLatencyMs: 30_000,
      residentMemoryBytes: 8_000,
      databaseSizeBytes: 100_000,
      taskQueueSizeBytes: 10_000
    });

    expect(decision.reasons).toEqual([
      "resident_memory",
      "database_size"
    ]);
    expect(decision.submissionPolicy).toEqual({
      allowIndexWrites: false,
      allowRoutineEngineTasks: true,
      throttleIndexWrites: false
    });
  });

  it("fails closed for writes when pressure metrics are unavailable", () => {
    const controller = createSearchIndexingPressureController();
    const decision = controller.unavailable({
      queueLatencyMs: 30_000,
      residentMemoryBytes: 8_000,
      databaseSizeBytes: 100_000,
      taskQueueSizeBytes: 10_000
    });

    expect(decision).toMatchObject({
      reasons: ["pressure_unavailable"],
      pressure: null,
      submissionPolicy: {
        allowIndexWrites: false,
        allowRoutineEngineTasks: false,
        throttleIndexWrites: false
      }
    });
  });
});
