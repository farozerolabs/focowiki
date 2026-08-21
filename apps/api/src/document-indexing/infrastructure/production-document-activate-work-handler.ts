import type { ClaimedDocumentArtifactWork } from
  "../application/document-work-port.js";
import type {
  DocumentKnowledgeProjectionManifest,
  DocumentKnowledgeProjectionManifestPointer
} from "../application/document-knowledge-projection-manifest.js";
import {
  collectDocumentProjectionScopeOutputPages,
  mergeDocumentProjectionScopeOutputs
} from
  "../application/document-projection-scope-output-merge.js";
import { documentFixedWorkPublicId } from
  "../domain/document-fixed-work-identity.js";
import { omitAppliedProjectionScopeEffects } from
  "./document-projection-output-idempotency.js";
import { resolveDocumentProjectionOwnerVersion } from
  "./document-projection-owner-version.js";
import type { createDocumentResourceLanes } from
  "../application/document-resource-lanes.js";
import type { createDocumentKnowledgeProjectionManifestLoader } from
  "./document-knowledge-projection-manifest-loader.js";
import type { createPostgresDocumentArtifactWorkRepository } from
  "./postgres-document-artifact-work-repository.js";
import type { createPostgresDocumentReceiptRepository } from
  "./postgres-document-receipt-repository.js";
import type { createPostgresGeneratedPageRepository } from
  "./postgres-generated-page-repository.js";
import type { createPostgresProjectionScopeOutputRepository } from
  "./postgres-projection-scope-output-repository.js";
import type { createPostgresScopedActivationOwnerRepository } from
  "./postgres-scoped-activation-owner-repository.js";
import type { createPostgresDocumentDirectoryNavigation } from
  "./postgres-document-directory-navigation.js";
import {
  documentActivationOwnerRequests,
  documentProjectionOutputOwnerRequests
} from
  "./document-knowledge-projection-support.js";
import { applyPostgresDocumentFixedActivation } from
  "./postgres-document-fixed-activation.js";
import { enqueuePostgresDocumentWebhookEvent } from
  "./postgres-document-webhook-event.js";
import type { DatabaseClient } from "../../db/client.js";
import { rebaseDocumentActivationOwnerVersions } from
  "../application/document-activation-rebase.js";
import { MAXIMUM_PROJECTION_SCOPE_OUTPUTS_PER_DOCUMENT } from
  "../domain/document-projection-limits.js";

const RESULT_RETENTION_MILLISECONDS = 30 * 86_400_000;
const MAXIMUM_INLINE_ACTIVATION_REBASE_ATTEMPTS = 4;

export function createProductionDocumentActivateWorkHandler(input: {
  work: ReturnType<typeof createPostgresDocumentArtifactWorkRepository>;
  receipts: ReturnType<typeof createPostgresDocumentReceiptRepository>;
  loadManifest: ReturnType<
    typeof createDocumentKnowledgeProjectionManifestLoader
  >;
  pages: ReturnType<typeof createPostgresGeneratedPageRepository>;
  scopeOutputs: ReturnType<typeof createPostgresProjectionScopeOutputRepository>;
  activationOwners: ReturnType<typeof createPostgresScopedActivationOwnerRepository>;
  directoryNavigation: ReturnType<typeof createPostgresDocumentDirectoryNavigation>;
  lanes: ReturnType<typeof createDocumentResourceLanes>;
  now?: () => string;
}) {
  const clock = input.now ?? (() => new Date().toISOString());
  return async (request: {
    claimed: ClaimedDocumentArtifactWork;
    signal: AbortSignal;
    releasePrimaryLane(): void;
  }) => {
    const { pointer, storedManifest } = await input.lanes.run(
      "postgres_s3",
      async () => {
      const receipt = await input.receipts.findForRevision({
        knowledgeBaseId: request.claimed.knowledgeBaseId,
        sourceRevisionPublicId: request.claimed.sourceRevisionPublicId,
        kind: "generated_page",
        key: "closure"
      });
      const pointer = projectionPointer(receipt?.value);
      const storedManifest = await input.loadManifest({
        pointer,
        signal: request.signal
      });
      return { pointer, storedManifest };
      },
      request.signal
    );
    if (storedManifest.knowledgeBaseId !== request.claimed.knowledgeBaseId
      || storedManifest.documentJobPublicId !== request.claimed.documentJobPublicId
      || storedManifest.sourceFilePublicId !== request.claimed.sourceFilePublicId
      || storedManifest.sourceRevisionPublicId
        !== request.claimed.sourceRevisionPublicId) {
      throw activationHandlerError("document_projection_manifest_stale");
    }
    for (let attempt = 1;
      attempt <= MAXIMUM_INLINE_ACTIVATION_REBASE_ATTEMPTS;
      attempt += 1) {
      request.signal.throwIfAborted();
      let manifest: DocumentKnowledgeProjectionManifest;
      try {
        manifest = await input.lanes.run("postgres_s3", async () => {
          const hydrated = await hydrateProjectionManifest({
            input,
            manifest: storedManifest,
            stagedAt: clock()
          });
          const currentOwners = await input.activationOwners.readVersions({
            knowledgeBaseId: hydrated.knowledgeBaseId,
            owners: hydrated.activationOwners.map((owner) => ({
              kind: owner.kind,
              key: owner.key
            }))
          });
          return {
            ...hydrated,
            activationOwners: rebaseDocumentActivationOwnerVersions({
              desired: hydrated.activationOwners,
              current: currentOwners
            })
          };
        }, request.signal);
      } catch (error) {
        if (!isActivationRebaseError(error)) throw error;
        if (attempt < MAXIMUM_INLINE_ACTIVATION_REBASE_ATTEMPTS) continue;
        throw activationHandlerError("document_activation_rebase_required");
      }
      const activatedAt = clock();
      const receiptValue = {
        schemaVersion: "document-activation-receipt-v1",
        readinessSequence: manifest.readinessSequence,
        manifestChecksumSha256: pointer.checksumSha256,
        sourceFilePublicId: manifest.sourceFilePublicId,
        sourceRevisionPublicId: manifest.sourceRevisionPublicId,
        activationCriticalSectionMilliseconds: 0
      };
      try {
        const completed = await input.work.completeWithMutation({
        publicId: request.claimed.publicId,
        workerId: request.claimed.leaseOwner,
        now: activatedAt,
        receipt: {
          kind: "activation",
          key: "visible",
          inputFingerprintSha256: request.claimed.inputFingerprintSha256,
          outputFingerprintSha256: pointer.checksumSha256,
          value: receiptValue
        },
        apply: async (transaction) => {
          const activationStartedAt = performance.now();
          await applyPostgresDocumentFixedActivation({
            transaction,
            manifest,
            activatedAt
          });
          receiptValue.activationCriticalSectionMilliseconds = Math.max(
            0,
            Math.round((performance.now() - activationStartedAt) * 1_000)
              / 1_000
          );
        },
        afterComplete: (transaction) => completeOperation({
          transaction,
          claimed: request.claimed,
          activatedAt
        })
        });
        if (!completed) {
          throw activationHandlerError("document_activation_lease_lost");
        }
        return {
          key: "visible",
          outputFingerprintSha256: pointer.checksumSha256,
          value: receiptValue,
          serviceEndedAt: activatedAt,
          committedByHandler: true
        };
      } catch (error) {
        if (errorCode(error) !== "scoped_activation_conflict") throw error;
        if (attempt >= MAXIMUM_INLINE_ACTIVATION_REBASE_ATTEMPTS) {
          throw activationHandlerError("document_activation_rebase_required");
        }
      }
    }
    throw activationHandlerError("document_activation_rebase_required");
  };
}

const ACTIVATION_REBASE_ERROR_CODES = new Set([
  "projection_scope_candidate_missing"
]);

function isActivationRebaseError(error: unknown): boolean {
  return ACTIVATION_REBASE_ERROR_CODES.has(errorCode(error) ?? "");
}

async function hydrateProjectionManifest(input: {
  input: Parameters<typeof createProductionDocumentActivateWorkHandler>[0];
  manifest: DocumentKnowledgeProjectionManifest;
  stagedAt: string;
}): Promise<DocumentKnowledgeProjectionManifest> {
  const storedOutputs = await input.input.scopeOutputs.readForDocument({
    knowledgeBaseId: input.manifest.knowledgeBaseId,
    documentJobPublicId: input.manifest.documentJobPublicId,
    limit: MAXIMUM_PROJECTION_SCOPE_OUTPUTS_PER_DOCUMENT
  });
  const allPaths = [...new Set(storedOutputs.flatMap((output) => [
    ...output.pages.map((page) => page.normalizedPath),
    ...output.removedNormalizedPaths
  ]))].sort();
  const heads = await input.input.pages.readHeads({
    knowledgeBaseId: input.manifest.knowledgeBaseId,
    normalizedPaths: allPaths,
    limit: Math.max(1, allPaths.length)
  });
  const outputs = await omitAppliedProjectionScopeEffects({
    outputs: storedOutputs,
    heads,
    readDirectory: (directoryPath) => input.input.directoryNavigation.read({
      knowledgeBaseId: input.manifest.knowledgeBaseId,
      directoryPath,
      maximumLeaves: 10_000,
      maximumEntries: 100_000
    })
  });
  const outputPages = collectDocumentProjectionScopeOutputPages(outputs);
  if (outputPages.length === 0
    && outputs.every((output) => output.removedNormalizedPaths.length === 0
      && output.navigationMutations.length === 0)) {
    return input.manifest;
  }
  const candidates = await input.input.pages.stage({
    knowledgeBaseId: input.manifest.knowledgeBaseId,
    sourceWorkPublicId: documentFixedWorkPublicId(
      input.manifest.documentJobPublicId,
      "knowledge_projection"
    ),
    sourceFilePublicId: input.manifest.sourceFilePublicId,
    sourceRevisionPublicId: input.manifest.sourceRevisionPublicId,
    baseActivationRevision: input.manifest.readinessSequence,
    pages: outputPages,
    stagedAt: input.stagedAt
  });
  const assembled = mergeDocumentProjectionScopeOutputs({ outputs, candidates });
  const pageCandidates = [...new Map([
    ...input.manifest.pageCandidates,
    ...assembled.pageCandidates
  ].map((page) => [page.normalizedPath, page])).values()].sort((left, right) =>
    left.normalizedPath.localeCompare(right.normalizedPath, "en-US"));
  const desiredPaths = new Set(pageCandidates.map((page) =>
    page.normalizedPath));
  const removedPageNormalizedPaths = [...new Set([
    ...input.manifest.removedPageNormalizedPaths,
    ...assembled.removedPageNormalizedPaths
  ])].filter((path) => !desiredPaths.has(path)).sort();
  const navigationMutations = [...new Map([
    ...input.manifest.navigationMutations,
    ...assembled.navigationMutations
  ].map((mutation) => [mutation.directoryPath, mutation])).values()].sort(
    (left, right) => left.directoryPath.localeCompare(
      right.directoryPath,
      "en-US"
    )
  );
  const pageOwners = documentActivationOwnerRequests({
    sourceFilePublicId: input.manifest.sourceFilePublicId,
    sourceRevisionPublicId: input.manifest.sourceRevisionPublicId,
    pairPublicIds: [],
    familyPublicIds: [],
    pageCandidates,
    removedPaths: removedPageNormalizedPaths,
    navigationMutations
  }).filter((owner) => owner.kind === "page_head"
    || owner.kind === "directory_leaf"
    || owner.kind === "directory_entry");
  const versionByOwner = projectionOutputOwnerVersions(outputs);
  const ownerByKey = new Map(input.manifest.activationOwners.map((owner) => [
    `${owner.kind}\0${owner.key}`,
    owner
  ]));
  for (const owner of pageOwners) {
    const key = `${owner.kind}\0${owner.key}`;
    const current = ownerByKey.get(key);
    const expectedVersion = resolveDocumentProjectionOwnerVersion({
      scopeOutputVersion: versionByOwner.get(key),
      manifestVersion: current?.expectedVersion
    });
    if (expectedVersion === undefined) {
      throw activationHandlerError("projection_scope_owner_version_missing");
    }
    ownerByKey.set(key, {
      ...owner,
      expectedVersion
    });
  }
  return {
    ...input.manifest,
    pageCandidates,
    removedPageNormalizedPaths,
    navigationMutations,
    activationOwners: [...ownerByKey.values()].sort((left, right) =>
      left.kind.localeCompare(right.kind, "en-US")
      || left.key.localeCompare(right.key, "en-US"))
  };
}

function projectionOutputOwnerVersions(
  outputs: Awaited<ReturnType<ReturnType<
    typeof createPostgresProjectionScopeOutputRepository
  >["readForDocument"]>>
): Map<string, number> {
  const versions = new Map<string, number>();
  for (const output of outputs) {
    const expectedOwners = documentProjectionOutputOwnerRequests({
      pages: output.pages,
      removedPaths: output.removedNormalizedPaths,
      navigationMutations: output.navigationMutations
    });
    const stored = new Map(output.activationOwnerVersions.map((owner) => [
      `${owner.kind}\0${owner.key}`,
      owner.expectedVersion
    ]));
    for (const owner of expectedOwners) {
      const key = `${owner.kind}\0${owner.key}`;
      const version = stored.get(key);
      if (version === undefined) {
        throw activationHandlerError("projection_scope_owner_version_missing");
      }
      const current = versions.get(key);
      if (current !== undefined && current !== version) {
        throw activationHandlerError("projection_scope_owner_version_conflict");
      }
      versions.set(key, version);
    }
  }
  return versions;
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    && typeof error.code === "string" ? error.code : null;
}

async function completeOperation(input: {
  transaction: DatabaseClient;
  claimed: ClaimedDocumentArtifactWork;
  activatedAt: string;
}): Promise<void> {
  const rows = await input.transaction<Array<{
    operation_kind: string;
    revision: number | string;
  }>>`
    SELECT operation.operation_kind, job.revision
    FROM focowiki.document_processing_jobs job
    JOIN focowiki.operations operation
      ON operation.knowledge_base_id = job.knowledge_base_id
     AND operation.public_id = job.operation_public_id
    WHERE job.public_id = ${input.claimed.documentJobPublicId}
      AND job.state = 'available'
  `;
  const row = rows[0];
  if (!row) throw activationHandlerError("document_job_completion_missing");
  const expiresAt = new Date(
    Date.parse(input.activatedAt) + RESULT_RETENTION_MILLISECONDS
  ).toISOString();
  await enqueuePostgresDocumentWebhookEvent(input.transaction, {
    documentJobPublicId: input.claimed.documentJobPublicId,
    documentJobRevision: Number(row.revision),
    knowledgeBaseId: input.claimed.knowledgeBaseId,
    operationPublicId: await operationPublicId(input.transaction, input.claimed),
    sourceFilePublicId: input.claimed.sourceFilePublicId,
    eventType: "document.available",
    state: "available",
    occurredAt: input.activatedAt,
    expiresAt
  });
  const operationId = await operationPublicId(input.transaction, input.claimed);
  if (row.operation_kind !== "upload"
    && row.operation_kind !== "maintenance"
    && row.operation_kind !== "source_directory_move") {
    await input.transaction`
      UPDATE focowiki.operations
      SET state = 'completed', completed_at = ${input.activatedAt},
          updated_at = ${input.activatedAt}
      WHERE knowledge_base_id = ${input.claimed.knowledgeBaseId}
        AND public_id = ${operationId}
        AND state NOT IN (
          'completed', 'failed', 'cancelled', 'superseded',
          'timed_out', 'deleted'
        )
    `;
    await input.transaction`
      INSERT INTO focowiki.operation_results (
        public_id, knowledge_base_id, operation_kind, terminal_state,
        result_code, safe_message, result_summary, correlation_public_id,
        completed_at, expires_at
      ) VALUES (
        ${operationId}, ${input.claimed.knowledgeBaseId},
        ${row.operation_kind}, 'completed', 'DOCUMENT_AVAILABLE', NULL,
        ${input.transaction.json({
          sourceFilePublicId: input.claimed.sourceFilePublicId,
          sourceRevisionPublicId: input.claimed.sourceRevisionPublicId
        })}, ${input.claimed.documentJobPublicId}, ${input.activatedAt},
        ${expiresAt}
      ) ON CONFLICT (public_id) DO NOTHING
    `;
  }
}

async function operationPublicId(
  sql: DatabaseClient,
  claimed: ClaimedDocumentArtifactWork
): Promise<string> {
  const rows = await sql<Array<{ operation_public_id: string }>>`
    SELECT operation_public_id
    FROM focowiki.document_processing_jobs
    WHERE public_id = ${claimed.documentJobPublicId}
      AND knowledge_base_id = ${claimed.knowledgeBaseId}
      AND source_revision_public_id = ${claimed.sourceRevisionPublicId}
  `;
  if (!rows[0]) throw activationHandlerError("document_job_missing");
  return rows[0].operation_public_id;
}

function projectionPointer(
  value: Readonly<Record<string, unknown>> | undefined
): DocumentKnowledgeProjectionManifestPointer {
  const manifest = value?.manifest;
  if (value?.schemaVersion !== "document-knowledge-projection-receipt-v1"
    || !isRecord(manifest)
    || typeof manifest.objectId !== "string"
    || typeof manifest.storageKey !== "string"
    || typeof manifest.checksumSha256 !== "string"
    || typeof manifest.byteCount !== "number"
    || manifest.contentType !== "application/json; charset=utf-8"
    || manifest.objectFormat !== "okf-generated-json-v1") {
    throw activationHandlerError("document_projection_receipt_invalid");
  }
  return manifest as unknown as DocumentKnowledgeProjectionManifestPointer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function activationHandlerError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document activation handler error: ${code}`), {
    code
  });
}
