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
  preparedAt
) {
  assertPrecondition(precondition);
  if (precondition.kind === "projection-repair") {
    return [{
      text: `
        DELETE FROM focowiki.knowledge_base_projection_versions
        WHERE knowledge_base_id = $1
          AND projection_kind = $2
        RETURNING knowledge_base_id
      `,
      parameters: [
        precondition.knowledgeBaseId,
        precondition.projectionKind
      ]
    }];
  }
  if (precondition.kind === "lexical-rebuild") {
    return [{
      text: `
        UPDATE focowiki.publication_generations AS generation
        SET search_schema_version = NULL,
            tokenizer_contract_version = NULL,
            search_segmentation_version = NULL,
            updated_at = $2
        FROM focowiki.knowledge_bases AS knowledge_base
        WHERE knowledge_base.id = $1
          AND knowledge_base.deleted_at IS NULL
          AND generation.knowledge_base_id = knowledge_base.id
          AND generation.id = knowledge_base.active_generation_id
          AND generation.state = 'active'
        RETURNING generation.id
      `,
      parameters: [precondition.knowledgeBaseId, preparedAt]
    }];
  }
  if (precondition.kind === "storage-reconciliation") {
    return [{
      text: `
        INSERT INTO focowiki.storage_reconciliation_cycles (
          prefix, next_scan_at
        ) VALUES ($1, $2)
        ON CONFLICT (prefix) DO UPDATE
        SET next_scan_at = EXCLUDED.next_scan_at,
            updated_at = EXCLUDED.next_scan_at
        WHERE focowiki.storage_reconciliation_cycles.prefix = $1
          AND focowiki.storage_reconciliation_cycles.state IN ('idle', 'failed')
        RETURNING prefix
      `,
      parameters: [precondition.prefix, preparedAt]
    }];
  }
  return [];
}

function assertPrecondition(precondition) {
  if (!precondition?.kind || !precondition?.knowledgeBaseId) {
    throw new Error("Maintenance precondition is incomplete.");
  }
  if (
    precondition.kind === "projection-repair"
    && precondition.strategy !== "invalidate-run-owned-projection-version"
  ) {
    throw new Error("Projection-repair precondition strategy is invalid.");
  }
  if (
    precondition.kind === "lexical-rebuild"
    && precondition.strategy !== "invalidate-run-owned-lexical-version"
  ) {
    throw new Error("Lexical-rebuild precondition strategy is invalid.");
  }
  if (
    precondition.kind === "projection-compaction"
    && precondition.strategy !== "natural-segment-amplification"
  ) {
    throw new Error("Projection-compaction precondition strategy is invalid.");
  }
  if (
    precondition.kind === "storage-reconciliation"
    && precondition.strategy !== "advance-existing-cycle"
  ) {
    throw new Error("Storage-reconciliation precondition strategy is invalid.");
  }
}
