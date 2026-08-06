import type { DatabaseClient } from "../../db/client.js";
import { readMigrationSql } from "../../db/migrations.js";
import type { TransactionSql } from "postgres";
import type { StorageVnextOwnedScopeProof } from "../lifecycle/ports.js";
import type {
  StorageVnextOwnedPlaneInspection,
  StorageVnextResetBootstrapPlane
} from "./command.js";
import { StorageVnextOwnedScopeError, validateStorageVnextOwnedScopeProof } from "./owned-scope.js";
import { assertStorageVnextOwnedPlane } from "./plane-safety.js";

const OWNER_RELATION = "focowiki_validation.run_owner";

type OwnerRow = {
  run_id: string;
  owner_marker: string;
  proof_checksum: string;
  target: string;
  created_by_run: boolean;
  existed_before_run: boolean;
};

export function createStorageVnextPostgresPlane(input: {
  sql: DatabaseClient;
  bootstrapSql?: string;
}): StorageVnextResetBootstrapPlane {
  const bootstrapSql = input.bootstrapSql ?? readMigrationSql("001_storage_vnext.sql");

  return {
    plane: "postgres",
    inspect: (proof) => inspectPostgres(input.sql, proof),
    async reset(proof) {
      validateStorageVnextOwnedScopeProof(proof);
      await input.sql.begin(async (transaction) => {
        const inspection = await inspectPostgres(transaction, proof, true);
        assertStorageVnextOwnedPlane(inspection, proof, "postgres", proof.postgresScope);
        if (inspection.bootstrapState !== "empty") {
          await transaction.unsafe("DROP SCHEMA focowiki CASCADE");
        }
      });
    },
    async verifyReset(proof) {
      const inspection = await inspectPostgres(input.sql, proof);
      return isOwnedPostgres(inspection, proof) && inspection.bootstrapState === "empty";
    },
    async bootstrap(proof) {
      validateStorageVnextOwnedScopeProof(proof);
      await input.sql.begin(async (transaction) => {
        const inspection = await inspectPostgres(transaction, proof, true);
        assertStorageVnextOwnedPlane(inspection, proof, "postgres", proof.postgresScope);
        if (inspection.bootstrapState === "incompatible") {
          throw new StorageVnextOwnedScopeError("Owned PostgreSQL scope has an incompatible schema");
        }
        if (inspection.bootstrapState === "empty") {
          await transaction.unsafe(bootstrapSql);
        }
      });
    },
    async verifyBootstrap(proof) {
      const inspection = await inspectPostgres(input.sql, proof);
      return isOwnedPostgres(inspection, proof) && inspection.bootstrapState === "current";
    }
  };
}

async function inspectPostgres(
  sql: DatabaseClient | TransactionSql,
  candidateProof: StorageVnextOwnedScopeProof,
  lockOwner = false
): Promise<StorageVnextOwnedPlaneInspection> {
  const proof = validateStorageVnextOwnedScopeProof(candidateProof);
  const databaseRows = await sql<Array<{ database_name: string }>>`
    SELECT current_database() AS database_name
  `;
  const databaseName = databaseRows[0]?.database_name ?? "";
  const ownerRelationRows = await sql<Array<{ relation_exists: boolean }>>`
    SELECT to_regclass(${OWNER_RELATION}) IS NOT NULL AS relation_exists
  `;
  let owner: OwnerRow | null = null;

  if (ownerRelationRows[0]?.relation_exists) {
    const rows = lockOwner
      ? await sql<Array<OwnerRow>>`
          SELECT run_id, owner_marker, proof_checksum, target,
                 created_by_run, existed_before_run
          FROM focowiki_validation.run_owner
          WHERE singleton = true
          FOR SHARE
        `
      : await sql<Array<OwnerRow>>`
          SELECT run_id, owner_marker, proof_checksum, target,
                 created_by_run, existed_before_run
          FROM focowiki_validation.run_owner
          WHERE singleton = true
        `;
    owner = rows[0] ?? null;
  }

  const applicationSchemaRows = await sql<Array<{ schema_exists: boolean }>>`
    SELECT to_regnamespace('focowiki') IS NOT NULL AS schema_exists
  `;
  let bootstrapState: StorageVnextOwnedPlaneInspection["bootstrapState"] = "empty";
  if (applicationSchemaRows[0]?.schema_exists) {
    const markerRows = await sql<Array<{ marker_exists: boolean }>>`
      SELECT to_regclass('focowiki.runtime_generation') IS NOT NULL AS marker_exists
    `;
    if (markerRows[0]?.marker_exists) {
      const generationRows = await sql<Array<{ generation: string }>>`
        SELECT generation
        FROM focowiki.runtime_generation
        WHERE singleton = true
      `;
      bootstrapState = generationRows[0]?.generation === "storage-vnext-v1"
        ? "current"
        : "incompatible";
    } else {
      bootstrapState = "incompatible";
    }
  }

  const ownerMatchesProof = owner?.run_id === proof.runId
    && owner.proof_checksum === proof.proofChecksum
    && owner.target === proof.postgresScope;
  const unexpectedTargets = databaseName === proof.postgresScope ? [] : [databaseName];

  return {
    plane: "postgres",
    target: proof.postgresScope,
    exists: databaseName === proof.postgresScope && Boolean(owner),
    createdByRun: ownerMatchesProof && owner?.created_by_run === true,
    existedBeforeRun: ownerMatchesProof ? owner?.existed_before_run ?? true : true,
    broadTarget: databaseName !== proof.postgresScope,
    bootstrapState,
    ownerMarker: ownerMatchesProof ? owner?.owner_marker ?? null : null,
    unexpectedTargets
  };
}

function isOwnedPostgres(
  inspection: StorageVnextOwnedPlaneInspection,
  proof: StorageVnextOwnedScopeProof
): boolean {
  try {
    assertStorageVnextOwnedPlane(inspection, proof, "postgres", proof.postgresScope);
    return true;
  } catch {
    return false;
  }
}
