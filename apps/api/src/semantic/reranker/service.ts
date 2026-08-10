import { createHash, randomUUID } from "node:crypto";
import {
  decryptRuntimeSecret,
  encryptRuntimeSecret
} from "../../runtime-settings/encryption.js";
import type {
  RerankerConfigurationDraft,
  RerankerConfigurationPrivate,
  RerankerConfigurationPublic
} from "./configuration.js";
import { validateRerankerConfigurationDraft } from "./configuration.js";
import type { RerankerConfigurationRepository } from "./repository.js";
import type { RerankerTransport } from "./openai-compatible-transport.js";
import { RerankerTransportError } from "./openai-compatible-transport.js";

export type RerankerConfigurationAuditEvent = {
  eventType: string;
  configurationPublicId: string;
  revisionPublicId: string;
  actorPublicId: string | null;
  result: "success" | "failure" | "blocked";
  reasonCode: string | null;
  metadata: Readonly<Record<string, boolean | number | string | null>>;
  createdAt: string;
};

export class RerankerConfigurationServiceError extends Error {
  public constructor(public readonly code: string) {
    super(`Reranker configuration operation failed: ${code}`);
    this.name = "RerankerConfigurationServiceError";
  }
}

export function createRerankerConfigurationService(input: {
  repository: RerankerConfigurationRepository;
  transport: RerankerTransport;
  audit: { append(event: RerankerConfigurationAuditEvent): Promise<void> };
  deploymentSecret: string;
  createPublicId?: () => string;
  now?: () => string;
}) {
  const createPublicId = input.createPublicId ?? randomUUID;
  const now = input.now ?? (() => new Date().toISOString());
  return {
    async create(draft: RerankerConfigurationDraft, actorPublicId: string | null) {
      assertDraft(draft, false);
      const configurationPublicId = `reranker-config-${createPublicId()}`;
      const revisionPublicId = `reranker-revision-${createPublicId()}`;
      const configuration = await input.repository.create({
        configurationPublicId,
        revisionPublicId,
        ...toRevisionWrite(draft, input.deploymentSecret, null),
        createdAt: now()
      });
      await audit("reranker_configuration.created", configuration, actorPublicId,
        "success", null);
      return toPublic(configuration);
    },

    async update(
      configurationPublicId: string,
      expectedRevision: number,
      draft: RerankerConfigurationDraft,
      actorPublicId: string | null
    ) {
      assertDraft(draft, true);
      const existing = await requireConfiguration(
        input.repository,
        configurationPublicId
      );
      const encryptedApiKey = resolveUpdatedEncryptedApiKey(
        draft,
        existing,
        input.deploymentSecret
      );
      const updated = await input.repository.createRevision({
        configurationPublicId,
        revisionPublicId: `reranker-revision-${createPublicId()}`,
        ...toRevisionWrite(draft, input.deploymentSecret, encryptedApiKey),
        expectedConfigurationRevision: expectedRevision,
        createdAt: now()
      });
      await audit("reranker_configuration.updated", updated, actorPublicId,
        "success", null);
      return toPublic(updated);
    },

    async test(configurationPublicId: string, actorPublicId: string | null) {
      const configuration = await requireConfiguration(
        input.repository,
        configurationPublicId
      );
      try {
        const response = await input.transport.rerank({
          baseUrl: configuration.baseUrl,
          authenticationMode: configuration.authenticationMode,
          apiKey: decryptApiKey(configuration, input.deploymentSecret),
          modelName: configuration.modelName,
          query: "Which document is relevant?",
          documents: ["A bounded reranker validation document."],
          timeoutMs: configuration.timeoutMs,
          signal: null
        });
        if (response.scores.length !== 1
          || !Number.isFinite(response.scores[0])
          || response.scores[0]! < 0 || response.scores[0]! > 1) {
          throw new RerankerTransportError("invalid_response", false);
        }
        const validated = await input.repository.recordValidation({
          configurationPublicId,
          revisionPublicId: configuration.revisionPublicId,
          status: "valid",
          validationFingerprintSha256: validationFingerprint(configuration),
          safeValidationErrorCode: null,
          validatedAt: now()
        });
        await audit("reranker_configuration.tested", validated, actorPublicId,
          "success", null);
        return toPublic(validated);
      } catch (error) {
        const code = error instanceof RerankerTransportError
          ? error.code
          : "validation_failed";
        const failed = await input.repository.recordValidation({
          configurationPublicId,
          revisionPublicId: configuration.revisionPublicId,
          status: "invalid",
          validationFingerprintSha256: null,
          safeValidationErrorCode: code,
          validatedAt: now()
        });
        await audit("reranker_configuration.tested", failed, actorPublicId,
          "failure", code);
        throw serviceError(code);
      }
    },

    async activate(
      configurationPublicId: string,
      expectedRevision: number,
      actorPublicId: string | null
    ) {
      const current = await requireConfiguration(
        input.repository,
        configurationPublicId
      );
      if (current.validationStatus !== "valid") {
        throw serviceError("validation_required");
      }
      const updated = await input.repository.setLifecycle({
        configurationPublicId,
        status: "active",
        expectedConfigurationRevision: expectedRevision
      });
      await audit("reranker_configuration.activated", updated, actorPublicId,
        "success", null);
      return toPublic(updated);
    },

    async pause(
      configurationPublicId: string,
      expectedRevision: number,
      actorPublicId: string | null
    ) {
      const updated = await input.repository.setLifecycle({
        configurationPublicId,
        status: "paused",
        expectedConfigurationRevision: expectedRevision
      });
      await audit("reranker_configuration.paused", updated, actorPublicId,
        "success", null);
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
      await audit("reranker_configuration.resumed", updated, actorPublicId,
        "success", null);
      return toPublic(updated);
    },

    async delete(
      configurationPublicId: string,
      expectedRevision: number,
      actorPublicId: string | null
    ) {
      const existing = await requireConfiguration(
        input.repository,
        configurationPublicId
      );
      if (existing.lifecycleStatus === "active") {
        throw serviceError("configuration_in_use");
      }
      const deleted = await input.repository.delete({
        configurationPublicId,
        expectedConfigurationRevision: expectedRevision,
        deletedAt: now()
      });
      if (!deleted) throw serviceError("revision_conflict");
      await audit("reranker_configuration.deleted", existing, actorPublicId,
        "success", null);
      return true;
    },

    async get(configurationPublicId: string) {
      const value = await input.repository.get(configurationPublicId);
      return value ? toPublic(value) : null;
    },
    async getActive() {
      const value = await input.repository.getActive();
      return value ? toPublic(value) : null;
    },
    async list() {
      return Promise.all((await input.repository.list()).map(toPublic));
    }
  };

  async function audit(
    eventType: string,
    configuration: RerankerConfigurationPrivate,
    actorPublicId: string | null,
    result: RerankerConfigurationAuditEvent["result"],
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

export type RerankerConfigurationService = ReturnType<
  typeof createRerankerConfigurationService
>;

function assertDraft(
  draft: RerankerConfigurationDraft,
  apiKeyMayBeOmitted: boolean
): void {
  if (validateRerankerConfigurationDraft(draft, { apiKeyMayBeOmitted }).length) {
    throw serviceError("validation_error");
  }
}

function toRevisionWrite(
  draft: RerankerConfigurationDraft,
  deploymentSecret: string,
  encryptedOverride: string | null
) {
  return {
    displayName: draft.displayName.trim(),
    authenticationMode: draft.authenticationMode,
    baseUrl: draft.baseUrl.trim(),
    encryptedApiKey: encryptedOverride ?? (draft.apiKey === null
      ? null
      : encryptRuntimeSecret({ value: draft.apiKey, secret: deploymentSecret })),
    modelName: draft.modelName.trim(),
    timeoutMs: draft.timeoutMs,
    retryCount: draft.retryCount,
    minimumIntervalMs: draft.minimumIntervalMs,
    concurrency: draft.concurrency
  };
}

function resolveUpdatedEncryptedApiKey(
  draft: RerankerConfigurationDraft,
  existing: RerankerConfigurationPrivate,
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
  configuration: RerankerConfigurationPrivate,
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

function validationFingerprint(configuration: RerankerConfigurationPrivate): string {
  return createHash("sha256").update([
    configuration.baseUrl,
    configuration.modelName,
    configuration.authenticationMode
  ].join("\u001f")).digest("hex");
}

function toPublic(
  configuration: RerankerConfigurationPrivate
): RerankerConfigurationPublic {
  const { encryptedApiKey: _encryptedApiKey, ...safe } = configuration;
  return structuredClone(safe);
}

async function requireConfiguration(
  repository: RerankerConfigurationRepository,
  configurationPublicId: string
): Promise<RerankerConfigurationPrivate> {
  const value = await repository.get(configurationPublicId);
  if (!value) throw serviceError("not_found");
  return value;
}

function serviceError(code: string): RerankerConfigurationServiceError {
  return new RerankerConfigurationServiceError(code);
}
