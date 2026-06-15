export type ModelReceiveTimeouts = {
  maxMs: number;
  idleMs: number;
};

export class ModelReceiveTimeoutError extends Error {
  public constructor(reason: "idle" | "maximum") {
    super(
      reason === "idle"
        ? "Model response idle timeout reached"
        : "Model response maximum timeout reached"
    );
    this.name = "ModelReceiveTimeoutError";
  }
}

export async function receiveWithProgressTimeout<T>(input: {
  timeouts: ModelReceiveTimeouts;
  start: (progress: () => void) => Promise<T>;
}): Promise<T> {
  assertTimeouts(input.timeouts);

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout>;
    const clear = () => {
      clearTimeout(idleTimer);
      clearTimeout(maxTimer);
    };
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      clear();
      callback();
    };
    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        settle(() => reject(new ModelReceiveTimeoutError("idle")));
      }, input.timeouts.idleMs);
    };
    const maxTimer = setTimeout(() => {
      settle(() => reject(new ModelReceiveTimeoutError("maximum")));
    }, input.timeouts.maxMs);

    resetIdleTimer();

    input
      .start(() => {
        if (!settled) {
          resetIdleTimer();
        }
      })
      .then(
        (value) => settle(() => resolve(value)),
        (error: unknown) => settle(() => reject(error))
      );
  });
}

function assertTimeouts(timeouts: ModelReceiveTimeouts): void {
  if (
    !Number.isSafeInteger(timeouts.maxMs) ||
    !Number.isSafeInteger(timeouts.idleMs) ||
    timeouts.maxMs <= 0 ||
    timeouts.idleMs <= 0 ||
    timeouts.idleMs > timeouts.maxMs
  ) {
    throw new Error("Model receive timeouts must be positive integers with idle less than or equal to maximum");
  }
}
