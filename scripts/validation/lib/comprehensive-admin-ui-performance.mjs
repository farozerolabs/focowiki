import { createHash } from "node:crypto";

export const ADMIN_UI_PERFORMANCE_PROFILES = Object.freeze([
  "desktop-en",
  "desktop-zh",
  "mobile-en",
  "mobile-zh"
]);

export const ADMIN_UI_PERFORMANCE_ACTIONS = Object.freeze([
  "session.login",
  "home.search",
  "home.open-knowledge-base",
  "detail.processing",
  "detail.files",
  "detail.settings",
  "detail.back",
  "home.openapi-keys",
  "home.settings",
  "settings.rate-limits",
  "settings.worker",
  "settings.publication",
  "settings.graph",
  "settings.maintenance",
  "settings.search",
  "settings.semantic",
  "settings.embeddings",
  "settings.rerankers",
  "settings.models",
  "locale.switch-and-restore"
]);

export function buildAdminUiPerformanceReport(input) {
  if (!input || typeof input !== "object") {
    throw new Error("Admin UI performance input is invalid");
  }
  const profiles = assertProfiles(input.profiles);
  const expectedActionCount = ADMIN_UI_PERFORMANCE_ACTIONS.length;
  for (const profile of profiles) {
    const actionIds = profile.actions.map((action) => action.id);
    if (actionIds.length !== expectedActionCount
      || new Set(actionIds).size !== expectedActionCount) {
      throw new Error(`${profile.id}: Admin UI action evidence is incomplete`);
    }
    const missingActions = ADMIN_UI_PERFORMANCE_ACTIONS.filter((id) =>
      !actionIds.includes(id));
    if (missingActions.length > 0) {
      throw new Error(`${profile.id}: missing actions ${missingActions.join(", ")}`);
    }
    profile.actions.forEach((action) => assertAction(profile.id, action));
    assertPage(profile);
  }
  const failures = profiles.flatMap((profile) => [
    ...profile.actions.filter((action) => action.ok !== true).map((action) =>
      `${profile.id}:${action.id}`),
    ...(profile.page.failedRequestCount === 0 ? [] : [`${profile.id}:failed-requests`]),
    ...(profile.page.consoleErrorCount === 0 ? [] : [`${profile.id}:console-errors`]),
    ...(profile.page.pageErrorCount === 0 ? [] : [`${profile.id}:page-errors`]),
    ...(profile.page.horizontalOverflow === false ? [] : [`${profile.id}:overflow`])
  ]);
  const sanitized = {
    schemaVersion: 1,
    kind: "focowiki-comprehensive-admin-ui-performance",
    identitySha256: assertSha256(input.identitySha256),
    coverageMode: "exhaustive-profile-actions",
    generatedAt: assertTimestamp(input.generatedAt),
    ok: failures.length === 0,
    summary: {
      expectedProfileCount: ADMIN_UI_PERFORMANCE_PROFILES.length,
      observedProfileCount: profiles.length,
      expectedActionCountPerProfile: expectedActionCount,
      observedActionCount: profiles.reduce((sum, profile) =>
        sum + profile.actions.length, 0),
      failedItemCount: failures.length,
      failures
    },
    profiles
  };
  return {
    ...sanitized,
    evidenceSha256: hashJson(sanitized)
  };
}

function assertProfiles(value) {
  if (!Array.isArray(value) || value.length !== ADMIN_UI_PERFORMANCE_PROFILES.length) {
    throw new Error("Admin UI performance profiles are incomplete");
  }
  const byId = new Map(value.map((profile) => [profile?.id, profile]));
  if (byId.size !== value.length) {
    throw new Error("Admin UI performance profiles contain duplicate IDs");
  }
  const missing = ADMIN_UI_PERFORMANCE_PROFILES.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new Error(`Admin UI performance profiles are missing: ${missing.join(", ")}`);
  }
  return ADMIN_UI_PERFORMANCE_PROFILES.map((id) => structuredClone(byId.get(id)));
}

function assertAction(profileId, action) {
  if (!action || typeof action !== "object"
    || typeof action.id !== "string"
    || !ADMIN_UI_PERFORMANCE_ACTIONS.includes(action.id)
    || typeof action.ok !== "boolean") {
    throw new Error(`${profileId}: invalid Admin UI action evidence`);
  }
  for (const key of ["durationMs", "transferredBytes", "resourceCount", "failedRequestCount"]) {
    assertNonnegative(action[key], `${profileId}:${action.id}:${key}`);
  }
  if (typeof action.horizontalOverflow !== "boolean") {
    throw new Error(`${profileId}:${action.id}: layout evidence is missing`);
  }
}

function assertPage(profile) {
  if (!profile.page || typeof profile.page !== "object") {
    throw new Error(`${profile.id}: page performance evidence is missing`);
  }
  for (const key of [
    "navigationDurationMs",
    "domContentLoadedMs",
    "loadEventMs",
    "firstContentfulPaintMs",
    "largestContentfulPaintMs",
    "interactionLatencyMs",
    "cumulativeLayoutShift",
    "longTaskCount",
    "longTaskDurationMs",
    "transferredBytes",
    "resourceCount",
    "failedRequestCount",
    "consoleErrorCount",
    "pageErrorCount",
    "memoryStartBytes",
    "memoryEndBytes",
    "memoryPeakBytes"
  ]) assertNonnegative(profile.page[key], `${profile.id}:page:${key}`);
  if (typeof profile.page.horizontalOverflow !== "boolean") {
    throw new Error(`${profile.id}: page layout evidence is missing`);
  }
}

function assertNonnegative(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative finite number`);
  }
}

function assertSha256(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error("Admin UI performance identity is invalid");
  }
  return value;
}

function assertTimestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error("Admin UI performance timestamp is invalid");
  }
  return value;
}

function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
