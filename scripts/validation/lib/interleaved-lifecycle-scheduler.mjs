export function createDeferredLifecycleAction(work) {
  if (typeof work !== "function") {
    throw new Error("Deferred lifecycle work must be a function.");
  }
  const completion = Promise.resolve().then(work);
  return {
    settle() {
      return completion;
    }
  };
}

export async function executeLifecycleSchedule(input) {
  const order = input?.order ?? [];
  const deadlineAt = resolveDeadlineAt(input);
  if (new Set(order).size !== order.length) {
    throw new Error("Interleaved lifecycle order must be unique.");
  }
  for (const lifecycle of order) {
    if (typeof input?.actions?.[lifecycle] !== "function") {
      throw new Error(`Interleaved lifecycle is missing action: ${lifecycle}.`);
    }
  }

  const started = [];
  for (const lifecycle of order) {
    try {
      const action = await input.actions[lifecycle]();
      started.push({ lifecycle, action, startError: null });
    } catch (error) {
      started.push({ lifecycle, action: null, startError: error });
    }
  }

  const outcomes = await Promise.all(started.map(async (item) => {
    try {
      if (item.startError) throw item.startError;
      const settlement = typeof item.action?.settle === "function"
        ? item.action.settle()
        : item.action;
      const result = await settleBeforeDeadline(settlement, deadlineAt);
      return {
        lifecycle: item.lifecycle,
        state: result?.state ?? "completed",
        errorCode: null
      };
    } catch (error) {
      return {
        lifecycle: item.lifecycle,
        state: "failed",
        errorCode: error?.code ?? "LIFECYCLE_ACTION_FAILED"
      };
    }
  }));

  return { order: [...order], outcomes };
}

function resolveDeadlineAt(input) {
  if (input?.deadlineAt !== undefined) {
    const parsed = Date.parse(input.deadlineAt);
    if (!Number.isFinite(parsed)) {
      throw new Error("Interleaved lifecycle deadline must be an ISO timestamp.");
    }
    return parsed;
  }
  if (input?.deadlineMs === undefined) return null;
  if (!Number.isSafeInteger(input.deadlineMs) || input.deadlineMs < 1) {
    throw new Error("Interleaved lifecycle deadline must be a positive integer.");
  }
  return Date.now() + input.deadlineMs;
}

async function settleBeforeDeadline(settlement, deadlineAt) {
  if (deadlineAt === null) return settlement;
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw deadlineError();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(settlement),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(deadlineError()), remainingMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function deadlineError() {
  const error = new Error("Interleaved lifecycle exceeded its scenario deadline.");
  error.code = "LIFECYCLE_DEADLINE_EXCEEDED";
  return error;
}
