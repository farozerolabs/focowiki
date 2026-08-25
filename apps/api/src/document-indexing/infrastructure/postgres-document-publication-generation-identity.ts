import { createHash } from "node:crypto";
import type { DatabaseClient } from "../../db/client.js";

const MAXIMUM_SUCCESSOR_DEPTH = 64;
const LIVE_GENERATION_STATES = new Set([
  "planned", "rendering", "validating", "ready", "active"
]);
const TERMINAL_GENERATION_STATES = new Set(["quarantined", "obsolete"]);

export function canonicalPublicationHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function publicationScopePublicId(
  generationPublicId: string,
  identity: string
): string {
  return `projection-scope-generation-${canonicalPublicationHash({
    generationPublicId,
    identity
  })}`;
}

export async function resolveAvailablePublicationGenerationIdentity(
  sql: DatabaseClient,
  input: Readonly<{
    knowledgeBaseId: string;
    inputFingerprintSha256: string;
  }>
): Promise<Readonly<{
  generationPublicId: string;
  generationIdentitySha256: string;
  supersedesGenerationPublicId: string | null;
}> | null> {
  let generationIdentitySha256 = input.inputFingerprintSha256;
  let generationPublicId = publicationGenerationPublicId(
    generationIdentitySha256
  );
  let supersedesGenerationPublicId: string | null = null;
  const visited = new Set<string>();
  for (let depth = 0; depth < MAXIMUM_SUCCESSOR_DEPTH; depth += 1) {
    if (visited.has(generationPublicId)) {
      throw generationIdentityError("publication_generation_successor_cycle");
    }
    visited.add(generationPublicId);
    const rows = await sql<Array<{
      knowledge_base_id: string;
      state: string;
      superseded_by_generation_public_id: string | null;
    }>>`
      SELECT knowledge_base_id, state, superseded_by_generation_public_id
      FROM focowiki.projection_publication_generations
      WHERE public_id = ${generationPublicId}
    `;
    const existing = rows[0];
    if (!existing) {
      return {
        generationPublicId,
        generationIdentitySha256,
        supersedesGenerationPublicId
      };
    }
    if (existing.knowledge_base_id !== input.knowledgeBaseId) {
      throw generationIdentityError(
        "publication_generation_identity_owner_mismatch"
      );
    }
    if (LIVE_GENERATION_STATES.has(existing.state)) return null;
    if (!TERMINAL_GENERATION_STATES.has(existing.state)) {
      throw generationIdentityError("publication_generation_state_invalid");
    }
    supersedesGenerationPublicId = generationPublicId;
    if (existing.superseded_by_generation_public_id) {
      generationPublicId = existing.superseded_by_generation_public_id;
      continue;
    }
    generationIdentitySha256 = successorIdentity({
      inputFingerprintSha256: input.inputFingerprintSha256,
      supersedesGenerationPublicId
    });
    generationPublicId = publicationGenerationPublicId(
      generationIdentitySha256
    );
  }
  throw generationIdentityError("publication_generation_successor_depth_exceeded");
}

export async function createPostgresDocumentPublicationGeneration(
  sql: DatabaseClient,
  input: Readonly<{
    knowledgeBaseId: string;
    baseGenerationPublicId: string | null;
    targetFactEpoch: number;
    rendererContractVersion: string;
    deterministicChangedAt: string;
    inputFingerprintSha256: string;
    createdAt: string;
    recoverySupersedesGenerationPublicId?: string;
  }>
): Promise<Readonly<{
  generationPublicId: string;
  generationIdentitySha256: string;
}> | null> {
  const identity = await resolveAvailablePublicationGenerationIdentity(
    sql,
    input
  );
  if (!identity) return null;
  await sql`
    INSERT INTO focowiki.projection_publication_generations (
      public_id, knowledge_base_id, base_generation_public_id,
      target_fact_epoch, renderer_contract_version,
      deterministic_changed_at, input_fingerprint_sha256,
      planning_mode, full_rebuild_reason, recovery_evidence
    ) VALUES (
      ${identity.generationPublicId}, ${input.knowledgeBaseId},
      ${input.baseGenerationPublicId}, ${input.targetFactEpoch},
      ${input.rendererContractVersion}, ${input.deterministicChangedAt},
      ${identity.generationIdentitySha256},
      ${input.baseGenerationPublicId === null ? "initial" : "delta"},
      ${input.baseGenerationPublicId === null ? "empty_knowledge_base" : null},
      CASE WHEN ${input.recoverySupersedesGenerationPublicId ?? null}::text
          IS NULL THEN '{}'::jsonb
        ELSE jsonb_build_object(
          'outcome', 'minimum_replacement_planned',
          'supersedesGenerationPublicId',
            (${input.recoverySupersedesGenerationPublicId ?? null})::text
        )
      END
    )
  `;
  if (identity.supersedesGenerationPublicId) {
    await sql`
      UPDATE focowiki.projection_publication_generations
      SET superseded_by_generation_public_id = ${identity.generationPublicId},
          recovery_evidence = recovery_evidence || jsonb_build_object(
            'replacementGenerationPublicId',
              (${identity.generationPublicId})::text,
            'replacementRendererContractVersion',
              (${input.rendererContractVersion})::text,
            'outcome', 'terminal_successor_planned'
          ),
          updated_at = ${input.createdAt}
      WHERE public_id = ${identity.supersedesGenerationPublicId}
        AND state IN ('quarantined', 'obsolete')
        AND (
          superseded_by_generation_public_id IS NULL
          OR superseded_by_generation_public_id = ${identity.generationPublicId}
        )
    `;
  }
  return identity;
}

function publicationGenerationPublicId(identity: string): string {
  return `projection-generation-${identity}`;
}

function successorIdentity(input: Readonly<{
  inputFingerprintSha256: string;
  supersedesGenerationPublicId: string;
}>): string {
  return createHash("sha256").update(JSON.stringify({
    inputFingerprintSha256: input.inputFingerprintSha256,
    supersedesGenerationPublicId: input.supersedesGenerationPublicId
  })).digest("hex");
}

function generationIdentityError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Publication generation identity error: ${code}`), {
    code
  });
}
