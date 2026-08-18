import type { DatabaseClient } from "../../db/client.js";
import {
  DOCUMENT_MODEL_LAYERS,
  type DocumentModelLayerExecution,
  type DocumentModelLayerExecutionRepository
} from "../application/document-model-layer-execution.js";

export function createPostgresDocumentModelLayerExecutionRepository(
  sql: DatabaseClient
): DocumentModelLayerExecutionRepository {
  return {
    async record(input) {
      validate(input);
      await sql`
        INSERT INTO focowiki.document_model_layer_executions (
          public_id, knowledge_base_id, document_job_public_id,
          source_revision_public_id, layer, execution_identity_sha256,
          status, model_name, selected, reused, provider_request_count,
          provider_observations,
          wait_time_milliseconds, service_time_milliseconds,
          warning_count, error_code, started_at, ended_at
        ) VALUES (
          ${input.publicId}, ${input.knowledgeBaseId},
          ${input.documentJobPublicId}, ${input.sourceRevisionPublicId},
          ${input.layer}, ${input.executionIdentitySha256}, ${input.status},
          ${input.modelName}, ${input.selected}, ${input.reused},
          ${input.providerRequestCount}, ${sql.json(input.providerObservations as never)},
          ${input.waitTimeMs},
          ${input.serviceTimeMs}, ${input.warningCount}, ${input.errorCode},
          ${input.startedAt}, ${input.endedAt}
        )
        ON CONFLICT (public_id) DO NOTHING
      `;
    }
  };
}

function validate(input: DocumentModelLayerExecution): void {
  if (!input.publicId.startsWith("document-model-layer-")
    || !input.knowledgeBaseId || !input.documentJobPublicId
    || !input.sourceRevisionPublicId
    || !DOCUMENT_MODEL_LAYERS.includes(input.layer)
    || !/^[0-9a-f]{64}$/u.test(input.executionIdentitySha256)
    || !["running", "completed", "failed"].includes(input.status)
    || !input.modelName || input.modelName.length > 255
    || !Number.isSafeInteger(input.providerRequestCount)
    || input.providerRequestCount < 0
    || !validProviderObservations(input.providerObservations)
    || !Number.isSafeInteger(input.waitTimeMs) || input.waitTimeMs < 0
    || !Number.isSafeInteger(input.serviceTimeMs) || input.serviceTimeMs < 0
    || !Number.isSafeInteger(input.warningCount) || input.warningCount < 0
    || !Number.isFinite(Date.parse(input.startedAt))
    || input.endedAt !== null && !Number.isFinite(Date.parse(input.endedAt))) {
    throw Object.assign(new Error("Document model layer execution is invalid"), {
      code: "document_model_layer_execution_invalid"
    });
  }
}

function validProviderObservations(
  value: DocumentModelLayerExecution["providerObservations"]
): boolean {
  if (!Array.isArray(value) || value.length > 8
    || Buffer.byteLength(JSON.stringify(value), "utf8") > 32_768) {
    return false;
  }
  return value.every((item) =>
    ["responses", "chat_completions"].includes(item.apiMode)
    && ["native_json_schema", "json_object_compatibility", "unknown"]
      .includes(item.structuredOutputCapability)
    && Number.isSafeInteger(item.attempt) && item.attempt >= 1 && item.attempt <= 8
    && typeof item.repair === "boolean"
    && (item.requestId === null
      || typeof item.requestId === "string" && item.requestId.length <= 255)
    && (item.finishState === null
      || typeof item.finishState === "string" && item.finishState.length <= 128)
    && [item.inputTokens, item.outputTokens, item.cachedInputTokens]
      .every((count) => count === null
        || Number.isSafeInteger(count) && Number(count) >= 0)
    && Number.isSafeInteger(item.serviceTimeMs) && item.serviceTimeMs >= 0
    && ["none", "refusal", "incomplete", "schema_validation", "transient", "provider"]
      .includes(item.errorClass)
  );
}
