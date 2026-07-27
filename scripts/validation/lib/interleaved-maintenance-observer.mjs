import { createRequire } from "node:module";

const require = createRequire(
  new URL("../../../apps/api/package.json", import.meta.url)
);
const postgres = require("postgres");

const TERMINAL_STATES = Object.freeze({
  "projection-repair": new Set(["completed", "failed", "superseded"]),
  "lexical-rebuild": new Set(["completed", "failed", "cancelled"]),
  "projection-compaction": new Set(["completed", "failed", "superseded"]),
  "storage-reconciliation": new Set(["idle", "failed"])
});

const SUCCESS_STATES = Object.freeze({
  "projection-repair": new Set(["completed"]),
  "lexical-rebuild": new Set(["completed"]),
  "projection-compaction": new Set(["completed", "superseded"]),
  "storage-reconciliation": new Set(["idle"])
});

export function createPostgresMaintenanceObserver(input) {
  if (!input?.databaseUrl) {
    throw new Error("Maintenance observer requires a database URL.");
  }
  const sql = postgres(input.databaseUrl, { max: 1, prepare: false });
  return {
    async observe(scope) {
      const query = maintenanceObservationQuery(scope);
      const rows = await sql.unsafe(query.text, query.parameters);
      return rows[0] ?? null;
    },
    close() {
      return sql.end({ timeout: 5 });
    }
  };
}

export function maintenanceObservationQuery(input) {
  if (input.kind === "projection-repair") {
    return {
      text: `
        SELECT state, current_phase AS phase, created_at, updated_at,
               completed_at, last_error_code
        FROM focowiki.knowledge_base_projection_repairs
        WHERE knowledge_base_id = $1
        ORDER BY repair_version DESC
        LIMIT 1
      `,
      parameters: [input.knowledgeBaseId]
    };
  }
  if (input.kind === "lexical-rebuild") {
    return {
      text: `
        SELECT state, phase, created_at, updated_at, completed_at,
               last_error_code
        FROM focowiki.knowledge_base_lexical_rebuilds
        WHERE knowledge_base_id = $1
        LIMIT 1
      `,
      parameters: [input.knowledgeBaseId]
    };
  }
  if (input.kind === "projection-compaction") {
    return {
      text: `
        SELECT state, projection_kind AS phase, created_at, updated_at,
               completed_at, last_error_code
        FROM focowiki.projection_compaction_jobs
        WHERE knowledge_base_id = $1
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
      `,
      parameters: [input.knowledgeBaseId]
    };
  }
  if (input.kind === "storage-reconciliation") {
    return {
      text: `
        SELECT state, state AS phase, created_at, updated_at,
               scan_completed_at AS completed_at, scan_started_at,
               last_error_code
        FROM focowiki.storage_reconciliation_cycles
        WHERE prefix = $1
        LIMIT 1
      `,
      parameters: [input.prefix]
    };
  }
  throw new Error(`Unsupported maintenance observation kind: ${input.kind}.`);
}

export function classifyMaintenanceObservation(input) {
  const row = input.row;
  if (!row) {
    return {
      kind: input.kind,
      started: false,
      terminal: false,
      succeeded: false,
      state: null,
      phase: null,
      errorCode: null,
      updatedAt: null
    };
  }
  const observedStart = input.kind === "storage-reconciliation"
    ? row.scan_started_at
    : row.created_at;
  const started = timestampAtOrAfter(observedStart, input.preparedAt)
    || timestampAtOrAfter(row.updated_at, input.preparedAt);
  const terminal = started && TERMINAL_STATES[input.kind]?.has(row.state) === true;
  return {
    kind: input.kind,
    started,
    terminal,
    succeeded: terminal && SUCCESS_STATES[input.kind]?.has(row.state) === true,
    state: row.state ?? null,
    phase: row.phase ?? null,
    errorCode: row.last_error_code ?? null,
    updatedAt: toIso(row.updated_at)
  };
}

export async function waitForMaintenanceLifecycle(input) {
  if (typeof input?.observe !== "function") {
    throw new Error("Maintenance lifecycle wait requires an observer.");
  }
  const timeoutMs = input.timeoutMs ?? 5 * 60_000;
  const pollIntervalMs = input.pollIntervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  let last = null;

  while (Date.now() < deadline) {
    last = classifyMaintenanceObservation({
      kind: input.kind,
      preparedAt: input.preparedAt,
      row: await input.observe()
    });
    input.onObservation?.(last);
    if (last.terminal) {
      if (!last.succeeded) {
        const error = new Error(
          `${input.kind} ended in ${last.state ?? "unknown"}.`
        );
        error.code = last.errorCode ?? "MAINTENANCE_FAILED";
        throw error;
      }
      return last;
    }
    await sleep(pollIntervalMs);
  }

  const error = new Error(
    `${input.kind} did not reach a terminal state before its deadline.`
  );
  error.code = "MAINTENANCE_TIMEOUT";
  error.lastObservation = last;
  throw error;
}

export async function waitForMaintenanceStart(input) {
  if (typeof input?.observe !== "function") {
    throw new Error("Maintenance start wait requires an observer.");
  }
  const timeoutMs = input.timeoutMs ?? 5 * 60_000;
  const pollIntervalMs = input.pollIntervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  let last = null;

  while (Date.now() < deadline) {
    last = classifyMaintenanceObservation({
      kind: input.kind,
      preparedAt: input.preparedAt,
      row: await input.observe()
    });
    input.onObservation?.(last);
    if (last.started) return last;
    await sleep(pollIntervalMs);
  }

  const error = new Error(
    `${input.kind} did not start before its deadline.`
  );
  error.code = "MAINTENANCE_START_TIMEOUT";
  error.lastObservation = last;
  throw error;
}

function timestampAtOrAfter(value, threshold) {
  if (!value || !threshold) return false;
  const timestamp = new Date(value).getTime();
  const boundary = new Date(threshold).getTime();
  return Number.isFinite(timestamp)
    && Number.isFinite(boundary)
    && timestamp >= boundary;
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
