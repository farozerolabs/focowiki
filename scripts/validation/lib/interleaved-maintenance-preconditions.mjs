import { createRequire } from "node:module";

const require = createRequire(
  new URL("../../../apps/api/package.json", import.meta.url)
);
const postgres = require("postgres");

export function createInterleavedMaintenancePreconditions(input) {
  if (typeof input?.execute !== "function") {
    throw new Error("Maintenance preconditions require a statement executor.");
  }
  const now = input.now ?? (() => new Date());

  return {
    async prepare(precondition) {
      const preparedAt = now().toISOString();
      const statements = buildMaintenancePreconditionStatements(
        precondition,
        preparedAt
      );
      let preparedRowCount = 0;
      for (const statement of statements) {
        const rows = await input.execute(statement);
        preparedRowCount += Array.isArray(rows) ? rows.length : 0;
      }
      return {
        kind: precondition.kind,
        strategy: precondition.strategy,
        knowledgeBaseId: precondition.knowledgeBaseId,
        preparedAt,
        preparedRowCount
      };
    }
  };
}

export function createPostgresInterleavedMaintenancePreconditions(input) {
  if (!input?.databaseUrl) {
    throw new Error("Maintenance preconditions require a database URL.");
  }
  const sql = postgres(input.databaseUrl, { max: 1, prepare: false });
  const controller = createInterleavedMaintenancePreconditions({
    execute: (statement) => sql.unsafe(
      statement.text,
      statement.parameters
    ),
    now: input.now
  });
  return {
    ...controller,
    close() {
      return sql.end({ timeout: 5 });
    }
  };
}

export function buildMaintenancePreconditionStatements(
  precondition,
  _preparedAt
) {
  assertPrecondition(precondition);
  return [];
}

function assertPrecondition(precondition) {
  if (!precondition?.kind || !precondition?.knowledgeBaseId) {
    throw new Error("Maintenance precondition is incomplete.");
  }
  if (
    precondition.kind !== "index-maintenance"
    || precondition.strategy !== "request-run-owned-maintenance"
  ) {
    throw new Error("Maintenance precondition strategy is invalid.");
  }
}
