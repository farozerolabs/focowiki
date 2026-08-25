import type { DatabaseClient } from "../../db/client.js";
import { documentPublicationContentionDecision } from
  "../application/document-publication-activation.js";
import { activatePostgresDocumentPublicationPages } from
  "./postgres-document-publication-page-activation.js";
import { activatePostgresDocumentPublicationSources } from
  "./postgres-document-publication-source-activation.js";
import { completePostgresDocumentPublicationWork } from
  "./postgres-document-publication-work-activation.js";
import { releaseSupersededPublicationGenerationReferences } from
  "./postgres-document-publication-retention.js";
import {
  createActivationDeadlineSql,
  DOCUMENT_PUBLICATION_ACTIVATION_TIMEOUT_MS,
  isActivationDeadlineError
} from "./document-publication-activation-deadline.js";

const DOCUMENT_PUBLICATION_ACTIVATION_DEADLINE_RETRY_DELAY_MS = 30_000;

export function createPostgresDocumentPublicationActivation(input: {
  sql: DatabaseClient;
  maximumContentionAttempts?: number;
  activationTimeoutMs?: number;
  random?: () => number;
  clock?: () => string;
  wait?: (milliseconds: number) => Promise<void>;
  beforeHeadAdvance?: (input: Readonly<{
    generationPublicId: string;
    knowledgeBaseId: string;
    transaction: DatabaseClient;
  }>) => Promise<void>;
}) {
  const maximumAttempts = input.maximumContentionAttempts ?? 4;
  const activationTimeoutMs = input.activationTimeoutMs
    ?? DOCUMENT_PUBLICATION_ACTIVATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(activationTimeoutMs) || activationTimeoutMs < 1) {
    throw new Error("Document publication activation timeout is invalid");
  }
  const random = input.random ?? Math.random;
  const clock = input.clock ?? (() => new Date().toISOString());
  const wait = input.wait ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  return {
    async activate(request: Readonly<{
      generationPublicId: string;
      expectedHeadVersion: number;
      activatedAt: string;
    }>) {
      for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
        const activationStartedAt = Date.now();
        try {
          return await activateOnce(
            input.sql,
            request,
            activationTimeoutMs,
            input.beforeHeadAdvance
          );
        } catch (error) {
          if (isActivationDeadlineError({
            error,
            elapsedMilliseconds: Math.max(0, Date.now() - activationStartedAt),
            timeoutMilliseconds: activationTimeoutMs
          })) {
            await persistDeadlineDeferral({
              sql: input.sql,
              generationPublicId: request.generationPublicId,
              deferredAt: clock()
            });
            throw activationError("publication_activation_deadline_deferred", {
              cause: error
            });
          }
          const decision = documentPublicationContentionDecision({
            code: errorCode(error), attempt, maximumAttempts, random: random()
          });
          if (decision.action === "fail") throw error;
          if (decision.action === "defer") {
            await persistContentionDeferral({
              sql: input.sql,
              generationPublicId: request.generationPublicId,
              errorCode: errorCode(error),
              deferredAt: request.activatedAt,
              random: random()
            });
            throw activationError("publication_activation_contention_deferred", {
              cause: error
            });
          }
          if (decision.delayMilliseconds > 0) {
            await wait(decision.delayMilliseconds);
          }
        }
      }
      throw activationError("publication_activation_contention_deferred");
    }
  };
}

async function activateOnce(
  sql: DatabaseClient,
  input: Readonly<{
    generationPublicId: string;
    expectedHeadVersion: number;
    activatedAt: string;
  }>,
  activationTimeoutMs: number,
  beforeHeadAdvance?: (input: Readonly<{
    generationPublicId: string;
    knowledgeBaseId: string;
    transaction: DatabaseClient;
  }>) => Promise<void>
) {
  return sql.begin(async (rawTransaction) => {
    const deadline = createActivationDeadlineSql(
      rawTransaction as unknown as DatabaseClient,
      activationTimeoutMs
    );
    const transaction = deadline.sql;
    try {
      await transaction`SET LOCAL lock_timeout = '2s'`;
      await transaction`
        SELECT set_config(
          'statement_timeout',
          ${String(activationTimeoutMs)},
          true
        )
      `;
      const identities = await transaction<Array<{
        knowledge_base_id: string;
      }>>`
        SELECT knowledge_base_id
        FROM focowiki.projection_publication_generations
        WHERE public_id = ${input.generationPublicId}
      `;
      const identity = identities[0];
      if (!identity) throw activationError("publication_generation_not_ready");
      const heads = await transaction<Array<{
        active_generation_public_id: string | null;
        head_version: number | string;
      }>>`
        SELECT active_generation_public_id, head_version
        FROM focowiki.knowledge_base_projection_heads
        WHERE knowledge_base_id = ${identity.knowledge_base_id}
        FOR UPDATE
      `;
      const generations = await transaction<Array<{
        knowledge_base_id: string;
        base_generation_public_id: string | null;
        target_fact_epoch: number | string;
        output_fingerprint_sha256: string | null;
        state: string;
      }>>`
        SELECT knowledge_base_id, base_generation_public_id,
               target_fact_epoch, output_fingerprint_sha256, state
        FROM focowiki.projection_publication_generations
        WHERE public_id = ${input.generationPublicId}
        FOR UPDATE
      `;
      const generation = generations[0];
      if (!generation || generation.knowledge_base_id !== identity.knowledge_base_id
        || generation.state !== "ready"
        || !generation.output_fingerprint_sha256) {
        throw activationError("publication_generation_not_ready");
      }
      const head = heads[0];
      if (!head || head.active_generation_public_id
          !== generation.base_generation_public_id
        || Number(head.head_version) !== input.expectedHeadVersion) {
        throw activationError("publication_generation_stale_base");
      }
      await lockActivationReservations(transaction, input.generationPublicId);
      await assertGenerationClosure(transaction, input.generationPublicId);
      const targetFactEpoch = Number(generation.target_fact_epoch);
      await advanceActivationEpoch({
        sql: transaction,
        knowledgeBaseId: generation.knowledge_base_id,
        targetFactEpoch,
        activatedAt: input.activatedAt
      });
      const pages = await activatePostgresDocumentPublicationPages({
        transaction,
        generationPublicId: input.generationPublicId,
        knowledgeBaseId: generation.knowledge_base_id,
        targetFactEpoch,
        activatedAt: input.activatedAt
      });
      const sources = await activatePostgresDocumentPublicationSources({
        transaction,
        generationPublicId: input.generationPublicId,
        knowledgeBaseId: generation.knowledge_base_id,
        targetFactEpoch,
        activatedAt: input.activatedAt
      });
      const documentCount = await completePostgresDocumentPublicationWork({
        transaction,
        generationPublicId: input.generationPublicId,
        knowledgeBaseId: generation.knowledge_base_id,
        outputFingerprintSha256: generation.output_fingerprint_sha256,
        activatedAt: input.activatedAt
      });
      await beforeHeadAdvance?.({
        generationPublicId: input.generationPublicId,
        knowledgeBaseId: generation.knowledge_base_id,
        transaction
      });
      const advanced = await transaction<Array<{ head_version: number | string }>>`
        UPDATE focowiki.knowledge_base_projection_heads
        SET active_generation_public_id = ${input.generationPublicId},
            active_fact_epoch = ${targetFactEpoch},
            head_version = head_version + 1,
            updated_at = ${input.activatedAt}
        WHERE knowledge_base_id = ${generation.knowledge_base_id}
          AND active_generation_public_id
                IS NOT DISTINCT FROM ${generation.base_generation_public_id}
          AND head_version = ${input.expectedHeadVersion}
        RETURNING head_version
      `;
      if (!advanced[0]) {
        throw activationError("publication_generation_stale_base");
      }
      await transaction`
        UPDATE focowiki.projection_publication_generations
        SET state = 'obsolete', completed_at = ${input.activatedAt},
            updated_at = ${input.activatedAt}
        WHERE public_id = ${generation.base_generation_public_id}
          AND state = 'active'
      `;
      await transaction`
        UPDATE focowiki.projection_publication_generations
        SET state = 'active', completed_at = ${input.activatedAt},
            updated_at = ${input.activatedAt},
            activation_next_eligible_at = NULL, safe_error_code = NULL,
            recovery_evidence = CASE
              WHEN recovery_evidence->>'outcome'
                    = 'minimum_replacement_planned'
              THEN jsonb_set(
                recovery_evidence,
                '{outcome}',
                to_jsonb('minimum_replacement_activated'::text)
              )
              ELSE recovery_evidence
            END
        WHERE public_id = ${input.generationPublicId} AND state = 'ready'
      `;
      await transaction`
        INSERT INTO focowiki.projection_generation_retention (
          generation_public_id, retention_state, retain_until,
          reason, updated_at
        )
        SELECT ${generation.base_generation_public_id}, 'retained',
               ${input.activatedAt}::timestamptz + interval '7 days',
               'previous-active-generation', ${input.activatedAt}
        WHERE ${generation.base_generation_public_id}::text IS NOT NULL
        ON CONFLICT (generation_public_id) DO UPDATE
        SET retention_state = 'retained',
            retain_until = excluded.retain_until,
            reason = excluded.reason,
            updated_at = excluded.updated_at
      `;
      await releaseSupersededPublicationGenerationReferences({
        transaction,
        knowledgeBaseId: generation.knowledge_base_id,
        releaseGenerationPublicId: input.generationPublicId,
        retainedGenerationPublicId: generation.base_generation_public_id,
        releasedAt: input.activatedAt
      });
      return {
        generationPublicId: input.generationPublicId,
        knowledgeBaseId: generation.knowledge_base_id,
        targetFactEpoch,
        headVersion: Number(advanced[0].head_version),
        documentCount,
        sourceCount: sources.length,
        ...pages
      };
    } finally {
      deadline.dispose();
    }
  });
}

async function persistContentionDeferral(input: Readonly<{
  sql: DatabaseClient;
  generationPublicId: string;
  errorCode: string;
  deferredAt: string;
  random: number;
}>): Promise<void> {
  const delayMilliseconds = 250 + Math.floor(input.random * 750);
  await input.sql`
    UPDATE focowiki.projection_publication_generations
    SET activation_contention_count = activation_contention_count + 1,
        activation_next_eligible_at = ${input.deferredAt}::timestamptz
          + (${delayMilliseconds} * interval '1 millisecond'),
        safe_error_code = ${input.errorCode},
        updated_at = ${input.deferredAt}
    WHERE public_id = ${input.generationPublicId}
      AND state = 'ready'
  `;
}

async function persistDeadlineDeferral(input: Readonly<{
  sql: DatabaseClient;
  generationPublicId: string;
  deferredAt: string;
}>): Promise<void> {
  await input.sql`
    UPDATE focowiki.projection_publication_generations
    SET activation_contention_count = activation_contention_count + 1,
        activation_next_eligible_at = ${input.deferredAt}::timestamptz
          + (${DOCUMENT_PUBLICATION_ACTIVATION_DEADLINE_RETRY_DELAY_MS}
            * interval '1 millisecond'),
        safe_error_code = 'publication_activation_deadline_exceeded',
        updated_at = ${input.deferredAt}
    WHERE public_id = ${input.generationPublicId}
      AND state = 'ready'
  `;
}

async function advanceActivationEpoch(input: Readonly<{
  sql: DatabaseClient;
  knowledgeBaseId: string;
  targetFactEpoch: number;
  activatedAt: string;
}>): Promise<void> {
  await input.sql`
    INSERT INTO focowiki.knowledge_base_sequences (
      knowledge_base_id, current_sequence, updated_at
    ) VALUES (
      ${input.knowledgeBaseId}, ${input.targetFactEpoch}, ${input.activatedAt}
    )
    ON CONFLICT (knowledge_base_id) DO UPDATE
    SET current_sequence = greatest(
          knowledge_base_sequences.current_sequence,
          excluded.current_sequence
        ),
        updated_at = excluded.updated_at
  `;
}

async function lockActivationReservations(
  sql: DatabaseClient,
  generationPublicId: string
): Promise<void> {
  await sql`
    SELECT pg_advisory_xact_lock(hashtextextended(
      jsonb_build_array(reservation.knowledge_base_id,
        reservation.owner_family, reservation.owner_key)::text, 0
    ))
    FROM focowiki.projection_activation_owner_reservations reservation
    WHERE reservation.generation_public_id = ${generationPublicId}
    ORDER BY CASE reservation.owner_family
      WHEN 'source' THEN 1 WHEN 'relation' THEN 2 WHEN 'search' THEN 3
      WHEN 'page' THEN 4 WHEN 'directory' THEN 5 WHEN 'job' THEN 6
      WHEN 'receipt' THEN 7 WHEN 'outbox' THEN 8 ELSE 9 END,
      reservation.owner_key COLLATE "C"
  `;
}

async function assertGenerationClosure(
  sql: DatabaseClient,
  generationPublicId: string
): Promise<void> {
  const rows = await sql<Array<{
    incomplete_scope_count: number | string;
    validation_count: number | string;
    unverified_object_count: number | string;
  }>>`
    SELECT
      (SELECT count(*) FROM focowiki.projection_scope_generations
       WHERE publication_generation_public_id = ${generationPublicId}
         AND state <> 'completed') AS incomplete_scope_count,
      (SELECT count(*)
       FROM focowiki.projection_generation_validation_results
       WHERE generation_public_id = ${generationPublicId}
         AND check_name = 'coherent_generation' AND state = 'passed')
        AS validation_count,
      (SELECT count(*)
       FROM focowiki.projection_scope_generation_object_refs reference
       JOIN focowiki.projection_scope_generations scope
         ON scope.public_id = reference.scope_generation_public_id
       JOIN focowiki.object_registrations registration
         ON registration.object_id = reference.object_id
       WHERE scope.publication_generation_public_id = ${generationPublicId}
         AND registration.state <> 'verified') AS unverified_object_count
  `;
  const row = rows[0];
  if (!row || Number(row.incomplete_scope_count) !== 0
    || Number(row.validation_count) !== 1
    || Number(row.unverified_object_count) !== 0) {
    throw activationError("publication_generation_closure_incomplete");
  }
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code) : "unknown";
}

function activationError(
  code: string,
  options?: ErrorOptions
): Error & { code: string } {
  return Object.assign(
    new Error(`Document publication activation error: ${code}`, options),
    { code }
  );
}
