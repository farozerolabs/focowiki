import { createHash, randomUUID } from "node:crypto";
import {
  decryptRuntimeSecret,
  encryptRuntimeSecret
} from "../../runtime-settings/encryption.js";
import type {
  EmbeddingConfigurationDraft,
  EmbeddingConfigurationPrivate,
  EmbeddingConfigurationPublic
} from "./configuration.js";
import { validateEmbeddingConfigurationDraft } from "./configuration.js";
import type { EmbeddingConfigurationRepository } from "./repository.js";
import type { EmbeddingTransport } from "./openai-compatible-transport.js";
import { EmbeddingTransportError } from "./openai-compatible-transport.js";

export type EmbeddingConfigurationAuditEvent = {
  eventType: string;
  configurationPublicId: string;
  revisionPublicId: string;
  actorPublicId: string | null;
  result: "success" | "failure" | "blocked";
  reasonCode: string | null;
  metadata: Readonly<Record<string, boolean | number | string | null>>;
  createdAt: string;
};

export type EmbeddingConfigurationAuditPort = {
  append(event: EmbeddingConfigurationAuditEvent): Promise<void>;
};

export class EmbeddingConfigurationServiceError extends Error {
  public constructor(public readonly code: string) {
    super(`Embedding configuration operation failed: ${code}`);
    this.name = "EmbeddingConfigurationServiceError";
  }
}

export function createEmbeddingConfigurationService(input: {
  repository: EmbeddingConfigurationRepository;
  transport: EmbeddingTransport;
  audit: EmbeddingConfigurationAuditPort;
  deploymentSecret: string;
  createPublicId?: () => string;
  now?: () => string;
}) {
  const createPublicId = input.createPublicId ?? randomUUID;
  const now = input.now ?? (() => new Date().toISOString());

  return {
    async create(draft: EmbeddingConfigurationDraft, actorPublicId: string | null) {
      assertDraft(draft, false);
      const configurationPublicId = `embedding-config-${createPublicId()}`;
      const revisionPublicId = `embedding-revision-${createPublicId()}`;
      const createdAt = now();
      const configuration = await input.repository.create({
        configurationPublicId,
        revisionPublicId,
        ...toRevisionWrite(
          draft,
          input.deploymentSecret,
          null,
          revisionPublicId
        ),
        createdAt
      });
      await audit("embedding_configuration.created", configuration, actorPublicId, "success", null);
      return toPublic(configuration);
    },

    async update(
      configurationPublicId: string,
      expectedRevision: number,
      draft: EmbeddingConfigurationDraft,
      actorPublicId: string | null
    ) {
      assertDraft(draft, true);
      const existing = await requireConfiguration(input.repository, configurationPublicId);
      const encryptedApiKey = resolveUpdatedEncryptedApiKey(
        draft,
        existing,
        input.deploymentSecret
      );
      const revisionPublicId = `embedding-revision-${createPublicId()}`;
      const vectorContractUnchanged = sameVectorProducingContract(
        draft,
        existing,
        encryptedApiKey
      );
      const updated = await input.repository.createRevision({
        configurationPublicId,
        revisionPublicId,
        ...toRevisionWrite(
          draft,
          input.deploymentSecret,
          encryptedApiKey,
          vectorContractUnchanged
            ? existing.vectorProducingRevisionPublicId
            : revisionPublicId
        ),
        reuseValidationFromRevisionPublicId: vectorContractUnchanged
          ? existing.revisionPublicId
          : null,
        expectedConfigurationRevision: expectedRevision,
        createdAt: now()
      });
      await audit("embedding_configuration.updated", updated, actorPublicId, "success", null);
      return toPublic(updated);
    },

    async test(configurationPublicId: string, actorPublicId: string | null) {
      const configuration = await requireConfiguration(input.repository, configurationPublicId);
      const testedAt = now();
      try {
        const response = await input.transport.embed({
          baseUrl: configuration.baseUrl,
          authenticationMode: configuration.authenticationMode,
          apiKey: decryptApiKey(configuration, input.deploymentSecret),
          modelName: configuration.modelName,
          requestedDimension: configuration.requestedDimension,
          inputs: ["Focowiki embedding validation probe."],
          timeoutMs: configuration.timeoutMs,
          maximumResponseBytes: configuration.maximumResponseBytes,
          signal: null
        });
        const validated = await input.repository.recordValidation({
          configurationPublicId,
          revisionPublicId: configuration.revisionPublicId,
          status: "valid",
          resolvedDimension: response.dimension,
          validationFingerprintSha256: validationFingerprint(configuration, response.dimension),
          safeValidationErrorCode: null,
          validatedAt: testedAt
        });
        await audit("embedding_configuration.tested", validated, actorPublicId, "success", null);
        return toPublic(validated);
      } catch (error) {
        const code = error instanceof EmbeddingTransportError
          ? error.code
          : "validation_failed";
        const failed = await input.repository.recordValidation({
          configurationPublicId,
          revisionPublicId: configuration.revisionPublicId,
          status: "invalid",
          resolvedDimension: null,
          validationFingerprintSha256: null,
          safeValidationErrorCode: code,
          validatedAt: testedAt
        });
        await audit("embedding_configuration.tested", failed, actorPublicId, "failure", code);
        throw serviceError(code);
      }
    },

    async activate(
      configurationPublicId: string,
      expectedRevision: number,
      actorPublicId: string | null
    ) {
      const current = await requireConfiguration(input.repository, configurationPublicId);
      if (current.validationStatus !== "valid" || current.resolvedDimension === null) {
        throw serviceError("validation_required");
      }
      const updated = await input.repository.setLifecycle({
        configurationPublicId,
        status: "active",
        expectedConfigurationRevision: expectedRevision
      });
      await audit("embedding_configuration.activated", updated, actorPublicId, "success", null);
      return toPublic(updated);
    },

    async pause(
      configurationPublicId: string,
      expectedRevision: number,
      actorPublicId: string | null
    ) {
      await assertNotReferenced(input.repository, configurationPublicId);
      const updated = await input.repository.setLifecycle({
        configurationPublicId,
        status: "paused",
        expectedConfigurationRevision: expectedRevision
      });
      await audit("embedding_configuration.paused", updated, actorPublicId, "success", null);
      return toPublic(updated);
    },

    async resume(
      configurationPublicId: string,
      expectedRevision: number,
      actorPublicId: string | null
    ) {
      const updated = await input.repository.setLifecycle({
        configurationPublicId,
        status: "draft",
        expectedConfigurationRevision: expectedRevision
      });
      await audit("embedding_configuration.resumed", updated, actorPublicId, "success", null);
      return toPublic(updated);
    },

    async delete(
      configurationPublicId: string,
      expectedRevision: number,
      actorPublicId: string | null
    ) {
      await assertNotReferenced(input.repository, configurationPublicId);
      const existing = await requireConfiguration(input.repository, configurationPublicId);
      const deleted = await input.repository.delete({
        configurationPublicId,
        expectedConfigurationRevision: expectedRevision,
        deletedAt: now()
      });
      if (!deleted) throw serviceError("revision_conflict");
      await audit("embedding_configuration.deleted", existing, actorPublicId, "success", null);
      return true;
    },

    async get(configurationPublicId: string) {
      const value = await input.repository.get(configurationPublicId);
      return value ? toPublic(value) : null;
    },

    async list() {
      return Promise.all((await input.repository.list()).map(toPublic));
    }
  };

  async function audit(
    eventType: string,
    configuration: EmbeddingConfigurationPrivate,
    actorPublicId: string | null,
    result: EmbeddingConfigurationAuditEvent["result"],
    reasonCode: string | null
  ): Promise<void> {
    await input.audit.append({
      eventType,
      configurationPublicId: configuration.publicId,
      revisionPublicId: configuration.revisionPublicId,
      actorPublicId,
      result,
      reasonCode,
      metadata: {
        authenticationMode: configuration.authenticationMode,
        modelName: configuration.modelName,
        revision: configuration.revision,
        authenticationConfigured: configuration.apiKeyConfigured
      },
      createdAt: now()
    });
  }
}

export type EmbeddingConfigurationService = ReturnType<
  typeof createEmbeddingConfigurationService
>;

function assertDraft(draft: EmbeddingConfigurationDraft, apiKeyMayBeOmitted: boolean) {
  const issues = validateEmbeddingConfigurationDraft(draft, { apiKeyMayBeOmitted });
  if (issues.length > 0) throw serviceError("validation_error");
}

function toRevisionWrite(
  draft: EmbeddingConfigurationDraft,
  deploymentSecret: string,
  encryptedOverride: string | null,
  vectorProducingRevisionPublicId: string
) {
  return {
    displayName: draft.displayName.trim(),
    authenticationMode: draft.authenticationMode,
    baseUrl: draft.baseUrl.trim().replace(/\/$/u, ""),
    encryptedApiKey: encryptedOverride ?? (draft.apiKey === null
      ? null
      : encryptRuntimeSecret({ value: draft.apiKey, secret: deploymentSecret })),
    modelName: draft.modelName.trim(),
    requestedDimension: draft.requestedDimension,
    normalization: draft.normalization,
    maximumInputTokens: draft.maximumInputTokens,
    batchSize: draft.batchSize,
    timeoutMs: draft.timeoutMs,
    retryCount: draft.retryCount,
    minimumIntervalMs: draft.minimumIntervalMs,
    concurrency: draft.concurrency,
    maximumResponseBytes: draft.maximumResponseBytes,
    minimumVectorRelevance: draft.minimumVectorRelevance,
    vectorProducingRevisionPublicId
  };
}

function sameVectorProducingContract(
  draft: EmbeddingConfigurationDraft,
  existing: EmbeddingConfigurationPrivate,
  encryptedApiKey: string | null
): boolean {
  return draft.authenticationMode === existing.authenticationMode
    && draft.baseUrl.trim().replace(/\/$/u, "") === existing.baseUrl
    && encryptedApiKey === existing.encryptedApiKey
    && draft.modelName.trim() === existing.modelName
    && draft.requestedDimension === existing.requestedDimension
    && draft.normalization === existing.normalization
    && draft.maximumInputTokens === existing.maximumInputTokens;
}

function resolveUpdatedEncryptedApiKey(
  draft: EmbeddingConfigurationDraft,
  existing: EmbeddingConfigurationPrivate,
  deploymentSecret: string
): string | null {
  if (draft.authenticationMode === "none") return null;
  if (draft.apiKey !== null) {
    return encryptRuntimeSecret({ value: draft.apiKey, secret: deploymentSecret });
  }
  if (existing.authenticationMode === "api_key" && existing.encryptedApiKey) {
    return existing.encryptedApiKey;
  }
  throw serviceError("api_key_required");
}

function decryptApiKey(
  configuration: EmbeddingConfigurationPrivate,
  deploymentSecret: string
): string | null {
  if (configuration.authenticationMode === "none") return null;
  if (!configuration.encryptedApiKey) throw serviceError("credential_unavailable");
  try {
    return decryptRuntimeSecret({
      value: configuration.encryptedApiKey,
      secret: deploymentSecret
    });
  } catch {
    throw serviceError("credential_unavailable");
  }
}

function toPublic(
  configuration: EmbeddingConfigurationPrivate
): EmbeddingConfigurationPublic {
  const { encryptedApiKey: _encryptedApiKey, ...safe } = configuration;
  return structuredClone(safe);
}

function validationFingerprint(
  configuration: EmbeddingConfigurationPrivate,
  dimension: number
): string {
  return createHash("sha256").update([
    configuration.baseUrl,
    configuration.modelName,
    configuration.revisionPublicId,
    String(dimension)
  ].join("\u001f")).digest("hex");
}

async function requireConfiguration(
  repository: EmbeddingConfigurationRepository,
  configurationPublicId: string
): Promise<EmbeddingConfigurationPrivate> {
  const value = await repository.get(configurationPublicId);
  if (!value) throw serviceError("not_found");
  return value;
}

async function assertNotReferenced(
  repository: EmbeddingConfigurationRepository,
  configurationPublicId: string
): Promise<void> {
  if (await repository.countReferences(configurationPublicId) > 0) {
    throw serviceError("configuration_in_use");
  }
}

function serviceError(code: string): EmbeddingConfigurationServiceError {
  return new EmbeddingConfigurationServiceError(code);
}
