const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "superseded"]);
const LIVE_STATES = new Set(["queued", "running", "retry"]);

export function reconcileComprehensiveWorkerRuntime(input) {
  const expectedStages = uniqueStrings(input?.expectedStages, "expected stages");
  const evidenceStages = new Set(requireArray(
    input?.stageEvidence,
    "stage evidence"
  ).map((item) => {
    const record = requireRecord(item, "stage evidence");
    if (record.pass !== true) {
      throw new Error("Comprehensive worker stage evidence did not pass");
    }
    return requireString(record.stageKind, "stage evidence kind");
  }));
  const stageItems = requireArray(input?.stageItems, "stage items")
    .map((item) => inspectRetryableItem(item, {
      label: "semantic stage",
      kindField: "stageKind",
      maximumField: "maximumAttempts"
    }));
  const seenStageIds = new Set();
  for (const item of stageItems) {
    if (seenStageIds.has(item.identity)) {
      throw new Error("Comprehensive worker semantic stage identities are duplicated");
    }
    seenStageIds.add(item.identity);
  }
  const observedStages = new Set(stageItems.map((item) => item.stageKind));
  for (const stageKind of expectedStages) {
    if (!observedStages.has(stageKind) && !evidenceStages.has(stageKind)) {
      throw new Error(`Comprehensive worker stage coverage is missing: ${stageKind}`);
    }
  }

  const operationItems = inspectCollection(input?.operationItems, {
    label: "operation work",
    kindField: "workKind"
  });
  if (operationItems.length !== 0) {
    throw new Error("Comprehensive worker operation work did not drain");
  }
  const dirtyItems = inspectCollection(input?.dirtyItems, {
    label: "dirty partition",
    kindField: "reasonKind"
  });
  const webhookItems = inspectCollection(input?.webhookItems, {
    label: "webhook delivery",
    kindField: "eventType"
  });
  const now = Date.parse(requireString(input?.observedAt, "observation timestamp"));
  if (!Number.isFinite(now)) {
    throw new Error("Comprehensive worker observation timestamp is invalid");
  }
  const cleanupItems = requireArray(input?.cleanupItems, "cleanup items")
    .map((value) => {
      const item = requireRecord(value, "cleanup item");
      const state = requireString(item.state, "cleanup item state");
      assertLeaseReleased(item, "cleanup item");
      const attemptCount = nonnegativeInteger(item.attemptCount, "cleanup attempt count");
      if (state === "queued") {
        if (item.required !== false || Date.parse(item.notBefore) <= now) {
          throw new Error("Comprehensive worker queued cleanup is not bounded retention");
        }
      } else {
        assertTerminal(item, state, "cleanup item");
      }
      return {
        identity: requireString(item.identity, "cleanup identity"),
        actionKind: requireString(item.actionKind, "cleanup action kind"),
        state,
        attemptCount,
        disposition: state === "queued" ? "bounded_retention" : "terminal",
        pass: true
      };
    });
  assertUniqueIdentities(cleanupItems, "cleanup");

  const allRuntimeItems = [...stageItems, ...dirtyItems, ...webhookItems];
  const liveItems = allRuntimeItems.filter((item) => LIVE_STATES.has(item.state));
  if (liveItems.length > 0) {
    throw new Error("Comprehensive worker live work remains");
  }
  return {
    ok: true,
    expectedStages,
    stageEvidence: [...evidenceStages].sort(),
    counts: {
      semanticStages: stageItems.length,
      operationWork: operationItems.length,
      dirtyPartitions: dirtyItems.length,
      cleanupActions: cleanupItems.length,
      webhookDeliveries: webhookItems.length,
      live: 0,
      leased: 0,
      failed: allRuntimeItems.filter((item) => item.state === "failed").length,
      cancelled: allRuntimeItems.filter((item) => item.state === "cancelled").length,
      boundedRetention: cleanupItems.filter(
        (item) => item.disposition === "bounded_retention"
      ).length
    },
    stageItems,
    operationItems,
    dirtyItems,
    cleanupItems,
    webhookItems
  };
}

function inspectCollection(value, options) {
  const items = requireArray(value, `${options.label} items`)
    .map((item) => inspectRetryableItem(item, options));
  assertUniqueIdentities(items, options.label);
  return items;
}

function inspectRetryableItem(value, options) {
  const item = requireRecord(value, options.label);
  const state = requireString(item.state, `${options.label} state`);
  assertLeaseReleased(item, options.label);
  if (!TERMINAL_STATES.has(state)) {
    throw new Error(`Comprehensive worker ${options.label} is not terminal`);
  }
  assertTerminal(item, state, options.label);
  const attemptCount = nonnegativeInteger(
    item.attemptCount,
    `${options.label} attempt count`
  );
  const maximumAttempts = item[options.maximumField ?? "maximumAttempts"] === undefined
    ? null
    : nonnegativeInteger(
        item[options.maximumField ?? "maximumAttempts"],
        `${options.label} maximum attempts`
      );
  if (maximumAttempts !== null && attemptCount > maximumAttempts) {
    throw new Error(`Comprehensive worker ${options.label} exceeded retry limit`);
  }
  return {
    identity: requireString(item.identity, `${options.label} identity`),
    [options.kindField]: requireString(item[options.kindField], `${options.label} kind`),
    state,
    attemptCount,
    maximumAttempts,
    safeErrorCode: item.safeErrorCode ?? null,
    pass: true
  };
}

function assertTerminal(item, state, label) {
  if (!TERMINAL_STATES.has(state)) {
    throw new Error(`Comprehensive worker ${label} state is invalid`);
  }
  if (state === "failed" && !requireOptionalString(item.safeErrorCode)) {
    throw new Error(`Comprehensive worker ${label} failure has no safe error code`);
  }
  if (!requireOptionalString(item.completedAt)) {
    throw new Error(`Comprehensive worker ${label} terminal timestamp is missing`);
  }
}

function assertLeaseReleased(item, label) {
  if (item.leaseOwner !== null || item.leaseExpiresAt !== null) {
    throw new Error(`Comprehensive worker ${label} retains a lease`);
  }
}

function assertUniqueIdentities(items, label) {
  if (new Set(items.map((item) => item.identity)).size !== items.length) {
    throw new Error(`Comprehensive worker ${label} identities are duplicated`);
  }
}

function uniqueStrings(value, label) {
  const values = requireArray(value, label).map((item) => requireString(item, label));
  if (new Set(values).size !== values.length) {
    throw new Error(`Comprehensive worker ${label} are duplicated`);
  }
  return values.sort();
}

function nonnegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`Comprehensive worker ${label} is invalid`);
  }
  return number;
}

function requireOptionalString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function requireArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`Comprehensive worker ${label} are invalid`);
  }
  return value;
}

function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Comprehensive worker ${label} is invalid`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Comprehensive worker ${label} is invalid`);
  }
  return value;
}
