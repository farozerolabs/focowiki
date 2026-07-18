import { describe, expect, it } from "vitest";
import {
  assertDispatchPressureSettings,
  decideDispatchPressure,
  type DispatchPressureSettings,
  type DispatchPressureSnapshot
} from "../src/dispatch/source-dispatch-pressure.js";

const settings: DispatchPressureSettings = {
  hard: {
    sourceQueueDepth: 100,
    oldestSourceQueueAgeSeconds: 600,
    dirtyFileCount: 200,
    oldestDirtyAgeSeconds: 900,
    pendingImpactCount: 2_000
  },
  resume: {
    sourceQueueDepth: 60,
    oldestSourceQueueAgeSeconds: 300,
    dirtyFileCount: 120,
    oldestDirtyAgeSeconds: 450,
    pendingImpactCount: 1_200
  }
};

describe("source dispatch pressure", () => {
  it("pauses at a hard threshold and remains paused until every resume threshold is met", () => {
    const hard = snapshot({ sourceQueueDepth: 100 });
    expect(decideDispatchPressure({ currentlyPaused: false, snapshot: hard, settings })).toEqual({
      paused: true,
      reason: "sourceQueueDepth"
    });

    const between = snapshot({ sourceQueueDepth: 61 });
    expect(decideDispatchPressure({ currentlyPaused: true, snapshot: between, settings })).toEqual({
      paused: true,
      reason: "sourceQueueDepth"
    });

    const resumed = snapshot({ sourceQueueDepth: 60 });
    expect(decideDispatchPressure({ currentlyPaused: true, snapshot: resumed, settings })).toEqual({
      paused: false,
      reason: null
    });
  });

  it("rejects a resume threshold that cannot provide hysteresis", () => {
    expect(() => assertDispatchPressureSettings({
      hard: settings.hard,
      resume: { ...settings.resume, sourceQueueDepth: 100 }
    })).toThrow("below its hard threshold");
  });
});

function snapshot(overrides: Partial<DispatchPressureSnapshot>): DispatchPressureSnapshot {
  return {
    sourceQueueDepth: 0,
    oldestSourceQueueAgeSeconds: 0,
    dirtyFileCount: 0,
    oldestDirtyAgeSeconds: 0,
    pendingImpactCount: 0,
    ...overrides
  };
}
