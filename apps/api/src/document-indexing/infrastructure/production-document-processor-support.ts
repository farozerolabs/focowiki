import { createHash } from "node:crypto";
import {
  createOpenAIModelClient,
  type OpenAIModelClient
} from "@focowiki/okf";
import type { ModelAssistanceOptions } from
  "../../runtime-settings/model-assistance-options.js";
import type {
  SearchProviderOperationReceipt,
  SearchProviderRuntime
} from "../../application/ports/search-provider-runtime.js";
import type { DatabaseClient } from "../../db/client.js";
import { createRuntimeSettingsRepository } from
  "../../runtime-settings/repository.js";
import { createBoundedTaskRunner } from "../../runtime/task-runner.js";
import type { RuntimeSearchSettings } from "../../runtime-settings/types.js";
import {
  sanitizeSearchSettings,
  validateSearchSettings
} from "../../runtime-settings/validation.js";
import { buildSemanticDesiredFactSet } from
  "../../semantic/domain/graph-normalization.js";
import type { SemanticDesiredFactSet } from
  "../../semantic/domain/contracts.js";
import { buildSemanticEmbeddingInput, type SemanticEmbeddingInput } from
  "../../semantic/embedding/input-builder.js";
import { unlockGenerationModelRevision } from
  "../../semantic/infrastructure/generation-model-revision.js";
import { createS3StorageVnextSourceBodyStore } from
  "../../storage-vnext/catalog/s3-source-body-store.js";
import { createPostgresStorageVnextOwnershipRepository } from
  "../../storage-vnext/ownership/postgres-repository.js";
import type { DocumentJobContext } from
  "../application/document-job-context.js";
import { createDocumentSemanticPlan } from
  "../application/document-semantic-plan.js";
import {
  digest,
  now,
  ownerIdentity,
  processorError
} from "./production-document-identities.js";
import { abortableWait } from "./document-abortable-wait.js";
import {
  withProviderFailureReporting,
  type ProviderRequestFailureReporter
} from "../../semantic/provider-request-failure.js";

export { abortableWait } from "./document-abortable-wait.js";
export { metadataAliases } from "./production-document-metadata.js";
export {
  digest,
  generatedPageWriteAttempt,
  immutableArtifactWriteAttempt,
  now,
  ownerIdentity,
  processorError,
  writeAttempt
} from "./production-document-identities.js";

const MAX_CACHED_MODEL_CLIENTS = 32;
const modelClientCache = new Map<string, OpenAIModelClient>();

export async function readGeneratedSourceBody(
  store: ReturnType<typeof createS3StorageVnextSourceBodyStore>,
  source: {
    objectId: string;
    checksumSha256: string;
    byteCount: number;
    contentType: string;
  },
  maximumBytes: number,
  signal: AbortSignal
): Promise<string> {
  const stream = await store.readVerifiedStream({
    objectId: source.objectId,
    checksum: source.checksumSha256,
    byteCount: source.byteCount,
    contentType: source.contentType,
    maxBytes: maximumBytes,
    signal
  });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const hash = createHash("sha256");
  const parts: string[] = [];
  let byteCount = 0;
  for await (const chunk of stream) {
    if (signal.aborted) throw signal.reason ?? processorError("cancelled");
    byteCount += chunk.byteLength;
    if (byteCount > source.byteCount || byteCount > maximumBytes) {
      throw processorError("generated_source_size_limit");
    }
    hash.update(chunk);
    parts.push(decoder.decode(chunk, { stream: true }));
  }
  parts.push(decoder.decode());
  if (byteCount !== source.byteCount
    || hash.digest("hex") !== source.checksumSha256) {
    throw processorError("generated_source_checksum_mismatch");
  }
  return parts.join("");
}

export function createDirectoryLeafId(input: {
  prefix: "directory-leaf" | "extension-leaf";
  knowledgeBaseId: string;
  directoryPath: string;
  baseRevision: number;
  occupiedLeafIds: Set<string>;
  sequence: number;
}): string {
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const value = digest([
      input.prefix,
      input.knowledgeBaseId,
      input.directoryPath,
      String(input.baseRevision),
      String(input.sequence),
      String(attempt)
    ]);
    const id = [
      `${input.prefix}-`,
      value.slice(0, 8), "-", value.slice(8, 12), "-",
      value.slice(12, 16), "-", value.slice(16, 20), "-",
      value.slice(20, 32)
    ].join("");
    if (!input.occupiedLeafIds.has(id)) {
      input.occupiedLeafIds.add(id);
      return id;
    }
  }
  throw processorError("directory_leaf_identity_exhausted");
}

export function normalizeLogicalPath(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

export async function resolvePinnedModelAssistance(input: {
  repository: ReturnType<typeof createRuntimeSettingsRepository>;
  deploymentSecret: string;
  job: DocumentJobContext;
  onProviderFailure?: ProviderRequestFailureReporter;
}): Promise<ModelAssistanceOptions> {
  const publicId = requireIdentity(
    input.job.generationModelConfigurationPublicId,
    "generation_model_configuration_missing"
  );
  const revision = input.job.generationModelConfigurationRevision;
  if (!Number.isSafeInteger(revision) || revision === null || revision < 1) {
    throw processorError("generation_model_revision_invalid");
  }
  const stored = await input.repository.getModelRevision(publicId, revision);
  if (!stored) throw processorError("generation_model_revision_missing");
  const model = unlockGenerationModelRevision(stored, input.deploymentSecret);
  const clientIdentity = `${publicId}\u001f${revision}`;
  let client = modelClientCache.get(clientIdentity);
  if (!client) {
    client = createPacedModelClient(createOpenAIModelClient({
      apiMode: model.apiMode,
      apiKey: model.apiKey,
      baseUrl: model.baseUrl,
      requestTimeoutMs: model.requestMaxTimeoutMs
    }), {
      concurrency: model.suggestionConcurrency,
      minStartIntervalMs: model.requestMinIntervalMs
    });
    modelClientCache.set(clientIdentity, client);
    while (modelClientCache.size > MAX_CACHED_MODEL_CLIENTS) {
      modelClientCache.delete(modelClientCache.keys().next().value!);
    }
  }
  const reportedClient = withProviderFailureReporting(client, {
    apiMode: model.apiMode,
    baseUrl: model.baseUrl,
    modelName: model.modelName
  }, input.onProviderFailure);
  return {
    modelConfigId: model.id,
    apiMode: model.apiMode,
    client: reportedClient,
    modelName: model.modelName,
    contextWindowTokens: model.contextWindowTokens,
    receiveTimeouts: {
      maxMs: model.requestMaxTimeoutMs,
      idleMs: model.requestIdleTimeoutMs
    },
    suggestionConcurrency: model.suggestionConcurrency,
    transientRetryDelayMs: model.transientRetryDelayMs,
    ...(input.onProviderFailure
      ? { onProviderFailure: input.onProviderFailure }
      : {})
  };
}

export function createPacedModelClient(
  client: OpenAIModelClient,
  input: { concurrency: number; minStartIntervalMs: number }
): OpenAIModelClient {
  const runner = createBoundedTaskRunner(input.concurrency, {
    minStartIntervalMs: input.minStartIntervalMs
  });
  if (client.apiMode === "chat_completions") {
    return {
      apiMode: "chat_completions",
      get structuredOutputCapability() {
        return client.structuredOutputCapability ?? "native_json_schema";
      },
      chat: {
        completions: {
          create: (request, options) => runner.run(
            () => client.chat.completions.create(request, options)
          )
        }
      }
    };
  }
  return {
    apiMode: "responses",
    responses: {
      create: (request, options) => runner.run(
        () => client.responses.create(request, options)
      )
    }
  };
}

export function emptySemanticFacts(
  job: DocumentJobContext
): SemanticDesiredFactSet {
  return buildSemanticDesiredFactSet({
    knowledgeBaseId: job.knowledgeBaseId,
    semanticGenerationPublicId: requireIdentity(
      job.semanticGenerationPublicId,
      "semantic_generation_configuration_missing"
    ),
    sourceFilePublicId: job.sourceFilePublicId,
    sourceRevisionPublicId: job.sourceRevisionPublicId,
    logicalPath: "unselected.md",
    chunks: [],
    extraction: { entities: [], mentions: [], relationships: [] }
  });
}

export function buildEmbeddingInputs(input: {
  job: DocumentJobContext;
  logicalPath: string;
  plan: ReturnType<ReturnType<typeof createDocumentSemanticPlan>>;
  facts: SemanticDesiredFactSet;
  maximumEvidenceTargets: number;
}): SemanticEmbeddingInput[] {
  const content = input.plan.contentVectorInputs.map((chunk) =>
    buildSemanticEmbeddingInput({
      inputKind: "content",
      ownerPublicId: chunk.publicId,
      sourceFilePublicId: input.job.sourceFilePublicId,
      sourceRevisionPublicId: input.job.sourceRevisionPublicId,
      fields: { body: chunk.text },
      evidenceTargets: [{
        sourceFilePublicId: input.job.sourceFilePublicId,
        sourceRevisionPublicId: input.job.sourceRevisionPublicId,
        evidencePublicId: chunk.publicId,
        logicalPath: input.logicalPath
      }],
      maximumCharacters: 32_000,
      maximumEvidenceTargets: input.maximumEvidenceTargets
    })
  );
  const evidence = new Map(input.facts.evidence.map((item) => [item.publicId, item]));
  const mentionsByEntity = new Map<string, string[]>();
  for (const mention of input.facts.mentions) {
    const current = mentionsByEntity.get(mention.entityPublicId) ?? [];
    current.push(mention.evidencePublicId);
    mentionsByEntity.set(mention.entityPublicId, current);
  }
  const targets = (evidencePublicIds: readonly string[]) => evidencePublicIds
    .map((publicId) => evidence.get(publicId))
    .filter((item): item is NonNullable<typeof item> => item !== undefined)
    .slice(0, input.maximumEvidenceTargets)
    .map((item) => ({
      sourceFilePublicId: item.sourceFilePublicId,
      sourceRevisionPublicId: item.sourceRevisionPublicId,
      evidencePublicId: item.publicId,
      logicalPath: item.logicalPath
    }));
  const entities = input.facts.entities.flatMap((entity) => {
    const evidenceTargets = targets(mentionsByEntity.get(entity.publicId) ?? []);
    return evidenceTargets.length === 0 ? [] : [buildSemanticEmbeddingInput({
      inputKind: "entity",
      ownerPublicId: entity.publicId,
      sourceFilePublicId: input.job.sourceFilePublicId,
      sourceRevisionPublicId: input.job.sourceRevisionPublicId,
      fields: {
        label: entity.label,
        kind: entity.kind,
        description: entity.description ?? entity.label
      },
      evidenceTargets,
      maximumCharacters: 32_000,
      maximumEvidenceTargets: input.maximumEvidenceTargets
    })];
  });
  const entitiesById = new Map(
    input.facts.entities.map((item) => [item.publicId, item])
  );
  const relationships = input.facts.relationships.flatMap((relationship) => {
    const from = entitiesById.get(relationship.fromEntityPublicId);
    const to = entitiesById.get(relationship.toEntityPublicId);
    const evidenceTargets = targets(relationship.evidencePublicIds);
    return !from || !to || evidenceTargets.length === 0 ? []
      : [buildSemanticEmbeddingInput({
          inputKind: "relationship",
          ownerPublicId: relationship.publicId,
          sourceFilePublicId: input.job.sourceFilePublicId,
          sourceRevisionPublicId: input.job.sourceRevisionPublicId,
          fields: {
            sourceLabel: from.label,
            targetLabel: to.label,
            description: relationship.description ?? relationship.kind
          },
          evidenceTargets,
          maximumCharacters: 32_000,
          maximumEvidenceTargets: input.maximumEvidenceTargets
        })];
  });
  return [...content, ...entities, ...relationships];
}

export function requireIdentity(value: string | null, code: string): string {
  if (!value) throw processorError(code);
  return value;
}

export function pinnedSearchSettings(
  runtimeSettingsDocument: Readonly<Record<string, unknown>>
): RuntimeSearchSettings {
  const sections = recordValue(runtimeSettingsDocument.sections);
  const search = recordValue(sections.search);
  if (validateSearchSettings(search).length > 0) {
    throw processorError("search_settings_revision_invalid");
  }
  return sanitizeSearchSettings(search as RuntimeSearchSettings);
}

export async function readSearchProjection(
  sql: DatabaseClient,
  input: {
    knowledgeBaseId: string;
    providerKind: string;
    preferPreparing?: boolean;
  }
): Promise<{
  publicId: string;
  providerIndexUid: string;
  schemaChecksumSha256: string;
}> {
  const rows = await sql<Array<{
    public_id: string;
    provider_index_uid: string;
    schema_checksum_sha256: string;
  }>>`
    SELECT public_id, provider_index_uid, schema_checksum_sha256
    FROM focowiki.search_projections
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND provider_kind = ${input.providerKind}
      AND (
        state = 'active'
        OR (${input.preferPreparing ?? false} AND state = 'preparing')
      )
    ORDER BY CASE
               WHEN ${input.preferPreparing ?? false} AND state = 'preparing'
                 THEN 0
               ELSE 1
             END,
             updated_at DESC
    LIMIT 1
  `;
  const row = rows[0];
  if (!row || !/^[0-9a-f]{64}$/u.test(row.schema_checksum_sha256)) {
    throw processorError("search_projection_unavailable");
  }
  return {
    publicId: row.public_id,
    providerIndexUid: row.provider_index_uid,
    schemaChecksumSha256: row.schema_checksum_sha256
  };
}

export function preferMaintenanceSearchProjection(
  job: DocumentJobContext
): boolean {
  return job.operationKind === "maintenance";
}

export async function readVectorProjection(
  sql: DatabaseClient,
  input: {
    knowledgeBaseId: string;
    semanticGenerationPublicId: string;
    embeddingConfigurationRevisionPublicId: string;
    providerKind: string;
  }
): Promise<{ publicId: string; mappingFingerprintSha256: string }> {
  const rows = await sql<Array<{
    public_id: string;
    mapping_fingerprint_sha256: string;
  }>>`
    SELECT public_id, mapping_fingerprint_sha256
    FROM focowiki.semantic_projection_contracts
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND semantic_generation_public_id = ${input.semanticGenerationPublicId}
      AND embedding_configuration_revision_public_id
        = ${input.embeddingConfigurationRevisionPublicId}
      AND search_provider_kind = ${input.providerKind}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row || !/^[0-9a-f]{64}$/u.test(row.mapping_fingerprint_sha256)) {
    throw processorError("semantic_projection_contract_unavailable");
  }
  return {
    publicId: row.public_id,
    mappingFingerprintSha256: row.mapping_fingerprint_sha256
  };
}

export async function awaitProviderReceipt(
  provider: SearchProviderRuntime,
  receipt: SearchProviderOperationReceipt,
  settings: RuntimeSearchSettings,
  signal: AbortSignal
): Promise<void> {
  if (receipt.state === "completed") return;
  const deadline = Date.now() + settings.taskTimeoutMs;
  while (Date.now() < deadline) {
    if (signal.aborted) throw signal.reason;
    const status = await provider.operations.getOperation({
      operationRef: receipt.operationRef
    });
    if (status.state === "completed") return;
    if (status.state === "failed") throw processorError(status.errorCode);
    await abortableWait(settings.taskPollIntervalMs, signal);
  }
  throw processorError("search_provider_acknowledgement_timeout");
}

export async function isCurrentSourceRevision(
  sql: DatabaseClient,
  job: DocumentJobContext
): Promise<boolean> {
  const rows = await sql<Array<{ current: boolean }>>`
    SELECT EXISTS (
      SELECT 1
      FROM focowiki.source_file_active_revisions active
      JOIN focowiki.source_files source
        ON source.knowledge_base_id = active.knowledge_base_id
       AND source.public_id = active.source_file_public_id
       AND source.deleted_at IS NULL
      WHERE active.knowledge_base_id = ${job.knowledgeBaseId}
        AND active.source_file_public_id = ${job.sourceFilePublicId}
        AND active.current_source_revision_public_id
          = ${job.sourceRevisionPublicId}
    ) AS current
  `;
  return rows[0]?.current === true;
}

export async function attachRevisionOwner(
  ownership: ReturnType<typeof createPostgresStorageVnextOwnershipRepository>,
  input: {
    job: DocumentJobContext;
    objectId: string;
    artifactKind: string;
  }
): Promise<void> {
  await ownership.attach({
    publicId: ownerIdentity(
      input.job.sourceRevisionPublicId,
      `${input.artifactKind}:${input.objectId}`
    ),
    knowledgeBaseId: input.job.knowledgeBaseId,
    objectId: input.objectId,
    kind: "source_revision",
    ownerPublicId: input.job.sourceRevisionPublicId,
    createdAt: now()
  });
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw processorError("runtime_settings_revision_invalid");
  }
  return value as Readonly<Record<string, unknown>>;
}
