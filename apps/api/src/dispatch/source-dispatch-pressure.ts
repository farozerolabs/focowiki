export type DispatchPressureSnapshot = {
  sourceQueueDepth: number;
  oldestSourceQueueAgeSeconds: number;
  dirtyFileCount: number;
  oldestDirtyAgeSeconds: number;
  pendingImpactCount: number;
};

export type DispatchPressureThresholds = DispatchPressureSnapshot;

export type DispatchPressureSettings = {
  hard: DispatchPressureThresholds;
  resume: DispatchPressureThresholds;
};

export type DispatchPressureDecision = {
  paused: boolean;
  reason: keyof DispatchPressureSnapshot | null;
};

const PRESSURE_KEYS = [
  "sourceQueueDepth",
  "oldestSourceQueueAgeSeconds",
  "dirtyFileCount",
  "oldestDirtyAgeSeconds",
  "pendingImpactCount"
] as const;

export function decideDispatchPressure(input: {
  currentlyPaused: boolean;
  snapshot: DispatchPressureSnapshot;
  settings: DispatchPressureSettings;
}): DispatchPressureDecision {
  if (input.currentlyPaused) {
    const blocking = PRESSURE_KEYS.find(
      (key) => input.snapshot[key] > input.settings.resume[key]
    );
    return blocking ? { paused: true, reason: blocking } : { paused: false, reason: null };
  }

  const blocking = PRESSURE_KEYS.find(
    (key) => input.snapshot[key] >= input.settings.hard[key]
  );
  return blocking ? { paused: true, reason: blocking } : { paused: false, reason: null };
}

export function assertDispatchPressureSettings(settings: DispatchPressureSettings): void {
  for (const key of PRESSURE_KEYS) {
    const hard = settings.hard[key];
    const resume = settings.resume[key];
    if (!Number.isSafeInteger(hard) || hard <= 0) {
      throw new Error(`Dispatch hard threshold ${key} must be a positive integer`);
    }
    if (!Number.isSafeInteger(resume) || resume < 0 || resume >= hard) {
      throw new Error(`Dispatch resume threshold ${key} must be below its hard threshold`);
    }
  }
}
