import { createHash } from "node:crypto";
import type { DatabaseClient } from "../../db/client.js";
import type { DocumentScopeGenerationRepository } from
  "../application/document-publication-repository-ports.js";
import { normalizeDocumentPublicationScopeOutput } from
  "../application/document-publication-scope-output.js";
import { normalizeDocumentProjectionOwnedPath } from
  "../application/document-projection-path-ownership.js";
import { enqueueProjectionCleanupOutbox } from
  "./postgres-projection-cleanup-outbox.js";
import { lockVerifiedDocumentObjectRegistrations } from
  "./postgres-document-object-registration-lock.js";
import {
  assertRepositoryIdentity,
  assertRepositorySha256,
  assertRepositoryTimestamp,
  repositoryContractError
} from "./document-repository-validation.js";

export async function reuseCompletedDocumentScopeGenerationOutput(
  sql: DatabaseClient,
  input: Parameters<DocumentScopeGenerationRepository["reuseCompletedOutput"]>[0]
): Promise<boolean> {
  const checkedAt = assertRepositoryTimestamp(input.checkedAt, "checked_at");
  const outcome = await sql.begin(async (transaction) => {
    const targets = await transaction<Array<{
      public_id: string;
      publication_generation_public_id: string;
      knowledge_base_id: string;
      scope_identity: string;
      state: string;
      input_snapshot_fingerprint_sha256: string;
      renderer_contract_version: string;
    }>>`
      SELECT scope.public_id, scope.publication_generation_public_id,
             scope.knowledge_base_id, scope.scope_identity, scope.state,
             scope.input_snapshot_fingerprint_sha256,
             generation.renderer_contract_version
      FROM focowiki.projection_scope_generations scope
      JOIN focowiki.projection_publication_generations generation
        ON generation.public_id = scope.publication_generation_public_id
      WHERE scope.public_id = ${assertRepositoryIdentity(
        input.scopeGenerationPublicId,
        "scope_generation_public_id"
      )}
      FOR UPDATE
    `;
    const target = targets[0];
    if (!target || target.state !== "waiting") return "not_reusable";
    const blocked = await transaction<Array<{ blocked: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM focowiki.projection_scope_generation_dependencies dependency
        JOIN focowiki.projection_scope_generations prerequisite
          ON prerequisite.public_id
               = dependency.depends_on_scope_generation_public_id
        WHERE dependency.scope_generation_public_id = ${target.public_id}
          AND prerequisite.state <> 'completed'
      ) AS blocked
    `;
    if (blocked[0]?.blocked) return "not_reusable";
    const sources = await transaction<Array<{
      public_id: string;
      output_fingerprint_sha256: string;
      validation_evidence: Record<string, unknown>;
    }>>`
      SELECT prior.public_id, prior.output_fingerprint_sha256,
             prior.validation_evidence
      FROM focowiki.projection_scope_generations prior
      JOIN focowiki.projection_publication_generations generation
        ON generation.public_id = prior.publication_generation_public_id
      WHERE prior.knowledge_base_id = ${target.knowledge_base_id}
        AND prior.scope_identity = ${target.scope_identity}
        AND prior.input_snapshot_fingerprint_sha256
              = ${target.input_snapshot_fingerprint_sha256}
        AND generation.renderer_contract_version
              = ${target.renderer_contract_version}
        AND prior.state = 'completed'
        AND prior.output_fingerprint_sha256 IS NOT NULL
      ORDER BY prior.completed_at DESC, prior.public_id COLLATE "C"
      LIMIT 2
    `;
    if (!sources[0]) return "not_reusable";
    if (sources[1] && sources[1].output_fingerprint_sha256
      !== sources[0].output_fingerprint_sha256) {
      await transaction`
        UPDATE focowiki.projection_scope_generations
        SET state = 'quarantined', updated_at = ${checkedAt}
        WHERE public_id = ${target.public_id}
      `;
      await transaction`
        UPDATE focowiki.projection_publication_generations
        SET state = 'quarantined', updated_at = ${checkedAt}
        WHERE public_id = ${target.publication_generation_public_id}
      `;
      await transaction`
        INSERT INTO focowiki.projection_invariant_diagnostics (
          public_id, knowledge_base_id, generation_public_id,
          invariant_code, safe_evidence, created_at
        ) VALUES (
          ${`projection-invariant-${hashIdentity([
            target.public_id,
            sources[0].output_fingerprint_sha256,
            sources[1].output_fingerprint_sha256
          ])}`}, ${target.knowledge_base_id},
          ${target.publication_generation_public_id},
          'same_snapshot_output_mismatch',
          ${transaction.json({ scopeIdentity: target.scope_identity } as never)},
          ${checkedAt}
        ) ON CONFLICT (public_id) DO NOTHING
      `;
      return "quarantined";
    }
    const source = sources[0];
    const sourceObjects = await transaction<Array<{ object_id: string }>>`
      SELECT DISTINCT object_id COLLATE "C" AS object_id
      FROM focowiki.projection_scope_generation_pages
      WHERE scope_generation_public_id = ${source.public_id}
        AND action = 'put' AND object_id IS NOT NULL
      ORDER BY object_id COLLATE "C"
    `;
    const sourceObjectIds = sourceObjects.map((item) => item.object_id);
    if (!await lockVerifiedDocumentObjectRegistrations(
      transaction as unknown as DatabaseClient,
      sourceObjectIds
    )) {
      return "not_reusable";
    }
    await transaction`
      INSERT INTO focowiki.projection_scope_generation_pages (
        scope_generation_public_id, publication_generation_public_id,
        owner_scope_identity, logical_path, normalized_path, action, entry_kind,
        object_id, checksum_sha256, byte_count
      )
      SELECT ${target.public_id}, ${target.publication_generation_public_id},
             ${target.scope_identity}, logical_path, normalized_path,
             action, entry_kind, object_id, checksum_sha256, byte_count
      FROM focowiki.projection_scope_generation_pages
      WHERE scope_generation_public_id = ${source.public_id}
      ORDER BY normalized_path COLLATE "C"
    `;
    const directories = await transaction<Array<{ directory_path: string }>>`
      SELECT DISTINCT directory_path
      FROM focowiki.projection_scope_navigation_mutations
      WHERE scope_generation_public_id = ${source.public_id}
      ORDER BY directory_path
    `;
    if (directories.length > 0) {
      await transaction`
        INSERT INTO focowiki.projection_generation_directory_claims (
          publication_generation_public_id, directory_path,
          scope_generation_public_id, owner_scope_identity
        )
        SELECT ${target.publication_generation_public_id}, directory_path,
               ${target.public_id}, ${target.scope_identity}
        FROM unnest(${directories.map((item) => item.directory_path)}::text[])
          desired(directory_path)
      `;
      await transaction`
        INSERT INTO focowiki.projection_scope_navigation_mutations (
          scope_generation_public_id, publication_generation_public_id,
          owner_scope_identity, directory_path, mutation_order,
          action, mutation
        )
        SELECT ${target.public_id}, ${target.publication_generation_public_id},
               ${target.scope_identity}, directory_path, mutation_order,
               action, mutation
        FROM focowiki.projection_scope_navigation_mutations
        WHERE scope_generation_public_id = ${source.public_id}
        ORDER BY directory_path COLLATE "C", mutation_order
      `;
    }
    if (sourceObjectIds.length > 0) {
      await transaction`
        INSERT INTO focowiki.projection_scope_generation_object_refs (
          scope_generation_public_id, object_id
        )
        SELECT ${target.public_id}, object_id
        FROM unnest(${sourceObjectIds}::text[]) desired(object_id)
        ORDER BY object_id COLLATE "C"
      `;
    }
    await transaction`
      UPDATE focowiki.projection_scope_generations
      SET state = 'completed',
          output_fingerprint_sha256
            = ${source.output_fingerprint_sha256},
          validation_evidence
            = ${transaction.json(source.validation_evidence as never)},
          consecutive_lease_loss_count = 0,
          last_progress_at = ${checkedAt},
          progress_evidence = jsonb_build_object('outcome', 'reused'),
          completed_at = ${checkedAt}, updated_at = ${checkedAt}
      WHERE public_id = ${target.public_id} AND state = 'waiting'
    `;
    return "reused";
  });
  if (outcome === "quarantined") {
    throw repositoryContractError("scope_generation_output_diverged");
  }
  return outcome === "reused";
    }

export async function persistDocumentScopeGenerationOutput(
  sql: DatabaseClient,
  input: Parameters<DocumentScopeGenerationRepository["persistOutput"]>[0]
): Promise<void> {
  const checkedAt = assertRepositoryTimestamp(input.checkedAt, "checked_at");
  const outcome = await sql.begin(async (transaction) => {
    const rows = await transaction<Array<{
      public_id: string;
      publication_generation_public_id: string;
      scope_identity: string;
      scope_kind: "source" | "relation" | "directory" | "graph"
        | "_index" | "_graph" | "root" | "validation";
      scope_key: string;
      state: string;
      lease_owner: string | null;
      lease_generation: number | string;
      lease_expires_at: Date | string | null;
      input_snapshot_fingerprint_sha256: string;
      output_fingerprint_sha256: string | null;
      renderer_contract_version: string;
      knowledge_base_id: string;
      scope_generation: number | string;
    }>>`
      SELECT scope.public_id, scope.publication_generation_public_id,
             scope.scope_identity, scope.scope_kind, scope.scope_key,
             scope.state, scope.lease_owner, scope.lease_generation,
             scope.lease_expires_at,
             scope.input_snapshot_fingerprint_sha256,
             scope.output_fingerprint_sha256,
             generation.renderer_contract_version,
             scope.knowledge_base_id, scope.scope_generation
      FROM focowiki.projection_scope_generations scope
      JOIN focowiki.projection_publication_generations generation
        ON generation.public_id = scope.publication_generation_public_id
      WHERE scope.public_id = ${assertRepositoryIdentity(
        input.scopeGenerationPublicId,
        "scope_generation_public_id"
      )}
      FOR UPDATE
    `;
    const scope = rows[0];
    if (!scope) throw repositoryContractError("scope_generation_not_found");
    const fingerprint = assertRepositorySha256(
      input.outputFingerprintSha256,
      "output_fingerprint"
    );
    const leaseExpiry = scope.lease_expires_at
      ? new Date(scope.lease_expires_at).getTime() : 0;
    if (scope.state !== "running"
      || scope.lease_owner !== assertRepositoryIdentity(
        input.workerId,
        "worker_id"
      )
      || Number(scope.lease_generation) !== input.leaseGeneration
      || leaseExpiry <= Date.parse(checkedAt)) {
      throw repositoryContractError("scope_generation_lease_lost");
    }
    const normalized = normalizeDocumentPublicationScopeOutput({
      scope: { kind: scope.scope_kind, key: scope.scope_key },
      sourceFilePublicId: scope.scope_kind === "source"
        ? scope.scope_key : null,
      inputSnapshotFingerprintSha256:
        scope.input_snapshot_fingerprint_sha256,
      rendererContractVersion: scope.renderer_contract_version,
      pages: input.pages,
      navigationMutations: input.navigationMutations,
      validationEvidence: input.validationEvidence
    });
    if (normalized.outputFingerprintSha256 !== fingerprint) {
      throw repositoryContractError("scope_generation_fingerprint_mismatch");
    }
    const pages = validatePages(normalized.pages);
    const navigation = validateNavigation(normalized.navigationMutations);
    const pageRows = pages.length === 0 ? []
      : await transaction<Array<{ normalized_path: string }>>`
        INSERT INTO focowiki.projection_scope_generation_pages (
          scope_generation_public_id, publication_generation_public_id,
          owner_scope_identity, logical_path, normalized_path,
          action, entry_kind,
          object_id, checksum_sha256, byte_count
        )
        SELECT ${input.scopeGenerationPublicId},
               ${scope.publication_generation_public_id},
               ${scope.scope_identity}, desired.logical_path,
               desired.normalized_path,
               desired.action, desired.entry_kind,
               desired.object_id, desired.checksum_sha256,
               desired.byte_count
        FROM jsonb_to_recordset(${transaction.json(pages as never)}::jsonb)
          AS desired(
            logical_path text, normalized_path text,
            action text, entry_kind text,
            object_id text, checksum_sha256 text, byte_count bigint
          )
        ON CONFLICT (scope_generation_public_id, normalized_path) DO UPDATE
        SET action = excluded.action
        WHERE projection_scope_generation_pages.action = excluded.action
          AND projection_scope_generation_pages.logical_path
                = excluded.logical_path
          AND projection_scope_generation_pages.entry_kind
                IS NOT DISTINCT FROM excluded.entry_kind
          AND projection_scope_generation_pages.object_id
                IS NOT DISTINCT FROM excluded.object_id
          AND projection_scope_generation_pages.checksum_sha256
                IS NOT DISTINCT FROM excluded.checksum_sha256
          AND projection_scope_generation_pages.byte_count
                IS NOT DISTINCT FROM excluded.byte_count
        RETURNING normalized_path
      `;
    if (pageRows.length !== pages.length) {
      throw repositoryContractError("scope_generation_output_conflict");
    }
    const claimedDirectories = [...new Set(navigation.map((mutation) =>
      mutation.directory_path))];
    if (claimedDirectories.length > 0) {
      const claims = await transaction<Array<{ directory_path: string }>>`
        INSERT INTO focowiki.projection_generation_directory_claims (
          publication_generation_public_id, directory_path,
          scope_generation_public_id, owner_scope_identity
        )
        SELECT ${scope.publication_generation_public_id}, directory_path,
               ${scope.public_id}, ${scope.scope_identity}
        FROM unnest(${claimedDirectories}::text[]) desired(directory_path)
        ON CONFLICT (publication_generation_public_id, directory_path)
        DO UPDATE SET directory_path = excluded.directory_path
        WHERE projection_generation_directory_claims
                .scope_generation_public_id
                = excluded.scope_generation_public_id
          AND projection_generation_directory_claims.owner_scope_identity
                = excluded.owner_scope_identity
        RETURNING directory_path
      `;
      if (claims.length !== claimedDirectories.length) {
        throw repositoryContractError("scope_navigation_owner_conflict");
      }
    }
    const navigationRows = navigation.length === 0 ? []
      : await transaction<Array<{ directory_path: string }>>`
        INSERT INTO focowiki.projection_scope_navigation_mutations (
          scope_generation_public_id, publication_generation_public_id,
          owner_scope_identity, directory_path, mutation_order, action,
          mutation
        )
        SELECT ${input.scopeGenerationPublicId},
               ${scope.publication_generation_public_id},
               ${scope.scope_identity}, desired.directory_path,
               desired.mutation_order, desired.action, desired.mutation
        FROM jsonb_to_recordset(${transaction.json(navigation as never)}::jsonb)
          AS desired(
            directory_path text, mutation_order integer,
            action text, mutation jsonb
          )
        ON CONFLICT (
          scope_generation_public_id, directory_path, mutation_order
        ) DO UPDATE SET action = excluded.action
        WHERE projection_scope_navigation_mutations.action = excluded.action
          AND projection_scope_navigation_mutations.mutation
                = excluded.mutation
        RETURNING directory_path
      `;
    if (navigationRows.length !== navigation.length) {
      throw repositoryContractError("scope_navigation_output_conflict");
    }
    const rootNavigation = navigation.find((mutation) =>
      mutation.directory_path === "pages"
        && Number.isSafeInteger(mutation.mutation.entryCount)
        && Number(mutation.mutation.entryCount) >= 0);
    if (rootNavigation) {
      await transaction`
        UPDATE focowiki.projection_generation_statistics
        SET root_entry_count = ${Number(rootNavigation.mutation.entryCount)}
        WHERE publication_generation_public_id
                = ${scope.publication_generation_public_id}
          AND knowledge_base_id = ${scope.knowledge_base_id}
      `;
    }
    const objectIds = [...new Set(pages.flatMap((page) =>
      page.object_id ? [page.object_id] : []))];
    if (objectIds.length > 0) {
      if (!await lockVerifiedDocumentObjectRegistrations(
        transaction as unknown as DatabaseClient,
        objectIds
      )) {
        throw repositoryContractError("scope_generation_object_unverified");
      }
      const references = await transaction<Array<{ object_id: string }>>`
        INSERT INTO focowiki.projection_scope_generation_object_refs (
          scope_generation_public_id, object_id
        )
        SELECT ${input.scopeGenerationPublicId}, object_id
        FROM unnest(${objectIds}::text[]) desired(object_id)
        ON CONFLICT (scope_generation_public_id, object_id) DO UPDATE
        SET object_id = excluded.object_id
        RETURNING object_id
      `;
      if (references.length !== objectIds.length) {
        throw repositoryContractError("scope_generation_object_unverified");
      }
    }
    if (input.verifiedReservations.length > 0) {
      const referenced = new Set(objectIds);
      if (input.verifiedReservations.some((reservation) =>
        !referenced.has(reservation.objectId))) {
        throw repositoryContractError(
          "scope_generation_reservation_unreferenced"
        );
      }
      await enqueueProjectionCleanupOutbox({
        transaction: transaction as unknown as DatabaseClient,
        knowledgeBaseId: scope.knowledge_base_id,
        scopePublicId: scope.public_id,
        renderedSequence: Number(scope.scope_generation),
        reservations: input.verifiedReservations,
        createdAt: checkedAt
      });
    }
    await transaction`
      UPDATE focowiki.projection_scope_generations
      SET state = 'completed',
          output_fingerprint_sha256 = ${fingerprint},
          validation_evidence = ${transaction.json(
            normalized.validationEvidence as never
          )},
          consecutive_lease_loss_count = 0,
          last_progress_at = ${checkedAt},
          progress_evidence = jsonb_build_object('outcome', 'committed'),
          completed_at = ${checkedAt}, updated_at = ${checkedAt},
          lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL
      WHERE public_id = ${input.scopeGenerationPublicId}
    `;
    return "completed";
  });
  void outcome;
    }

function validatePages(input: readonly {
  logicalPath: string;
  normalizedPath: string;
  action: "put" | "delete";
  entryKind: string | null;
  objectId: string | null;
  checksumSha256: string | null;
  byteCount: number | null;
}[]) {
  if (input.length > 10_000) {
    throw repositoryContractError("scope_generation_page_limit");
  }
  const records = input.map((page) => ({
    logical_path: page.logicalPath,
    normalized_path: normalizeDocumentProjectionOwnedPath(page.normalizedPath),
    action: page.action,
    entry_kind: page.entryKind,
    object_id: page.objectId,
    checksum_sha256: page.checksumSha256,
    byte_count: page.byteCount
  }));
  if (new Set(records.map((page) => page.normalized_path)).size
    !== records.length) {
    throw repositoryContractError("scope_generation_page_duplicate");
  }
  return records;
}

function validateNavigation(input: readonly {
  directoryPath: string;
  order: number;
  action: "upsert" | "delete";
  mutation: Readonly<Record<string, unknown>>;
}[]) {
  if (input.length > 10_000) {
    throw repositoryContractError("scope_navigation_mutation_limit");
  }
  return input.map((mutation) => ({
    directory_path: mutation.directoryPath.toLocaleLowerCase("en-US"),
    mutation_order: mutation.order,
    action: mutation.action,
    mutation: mutation.mutation
  }));
}
function hashIdentity(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}
