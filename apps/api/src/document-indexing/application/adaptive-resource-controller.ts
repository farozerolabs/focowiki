export type AdaptiveResourceObservation = {
  outcome: "success" | "failure" | "rate_limited" | "timeout";
  latencyMs: number;
  cpuPressure: number;
  memoryPressure: number;
  pressureSource?: string;
};

export function createAdaptiveResourceController(input: {
  configuredMaximum: number;
  initialCapacity?: number;
  stableSuccessesBeforeIncrease?: number;
  consecutivePressureObservationsBeforeDecrease?: number;
}) {
  let maximum = boundedInteger(input.configuredMaximum, "maximum");
  let current = Math.min(
    maximum,
    boundedInteger(input.initialCapacity ?? maximum, "initial_capacity")
  );
  const stableThreshold = boundedInteger(
    input.stableSuccessesBeforeIncrease ?? 8,
    "stable_success_threshold"
  );
  const pressureThreshold = boundedInteger(
    input.consecutivePressureObservationsBeforeDecrease ?? 3,
    "pressure_observation_threshold"
  );
  let stableSuccesses = 0;
  let consecutivePressureObservations = 0;
  return {
    capacity(): number {
      return current;
    },
    configuredMaximum(): number {
      return maximum;
    },
    updateConfiguredMaximum(
      value: number,
      options: { preserveCurrent?: boolean } = {}
    ): number {
      const nextMaximum = boundedInteger(value, "maximum");
      if (nextMaximum === maximum) return current;
      maximum = nextMaximum;
      current = options.preserveCurrent
        ? Math.min(current, maximum)
        : maximum;
      stableSuccesses = 0;
      consecutivePressureObservations = 0;
      return current;
    },
    observe(observation: AdaptiveResourceObservation): number {
      validateObservation(observation);
      const pressured = observation.cpuPressure >= 0.85
        || observation.memoryPressure >= 0.85;
      if (
        observation.outcome === "rate_limited"
        || observation.outcome === "timeout"
      ) {
        current = Math.max(1, Math.floor(current / 2));
        stableSuccesses = 0;
        consecutivePressureObservations = 0;
        return current;
      }
      if (pressured) {
        stableSuccesses = 0;
        consecutivePressureObservations += 1;
        if (consecutivePressureObservations >= pressureThreshold) {
          current = Math.max(1, Math.floor(current / 2));
          consecutivePressureObservations = 0;
        }
        return current;
      }
      consecutivePressureObservations = 0;
      if (observation.outcome !== "success") {
        stableSuccesses = 0;
        return current;
      }
      stableSuccesses += 1;
      if (stableSuccesses >= stableThreshold && current < maximum) {
        current += 1;
        stableSuccesses = 0;
      }
      return current;
    }
  };
}

function boundedInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new Error(`ADAPTIVE_RESOURCE_${name.toUpperCase()}_INVALID`);
  }
  return value;
}

function validateObservation(observation: AdaptiveResourceObservation): void {
  if (!Number.isFinite(observation.latencyMs) || observation.latencyMs < 0) {
    throw new Error("ADAPTIVE_RESOURCE_LATENCY_INVALID");
  }
  for (const pressure of [observation.cpuPressure, observation.memoryPressure]) {
    if (!Number.isFinite(pressure) || pressure < 0 || pressure > 1) {
      throw new Error("ADAPTIVE_RESOURCE_PRESSURE_INVALID");
    }
  }
  if (observation.pressureSource !== undefined
    && (!observation.pressureSource
      || observation.pressureSource.length > 128)) {
    throw new Error("ADAPTIVE_RESOURCE_PRESSURE_SOURCE_INVALID");
  }
}
