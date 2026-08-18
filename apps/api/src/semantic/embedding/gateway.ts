import { createBoundedTaskRunner } from "../../runtime/task-runner.js";
import type { EmbeddingConfigurationPrivate } from "./configuration.js";
import type {
  EmbeddingTransport,
  EmbeddingTransportResponse
} from "./openai-compatible-transport.js";
import { EmbeddingTransportError } from "./openai-compatible-transport.js";
import { decryptRuntimeSecret } from "../../runtime-settings/encryption.js";

export type EmbeddingGateway = {
  embed(input: {
    configuration: EmbeddingConfigurationPrivate;
    inputs: readonly string[];
    signal: AbortSignal | null;
  }): Promise<readonly (readonly number[])[]>;
};

export function createEmbeddingGateway(input: {
  transport: EmbeddingTransport;
  deploymentSecret: string;
  delay?: (milliseconds: number, signal: AbortSignal | null) => Promise<void>;
}): EmbeddingGateway {
  const runners = new Map<string, ReturnType<typeof createBoundedTaskRunner>>();
  const delay = input.delay ?? abortableDelay;
  return {
    async embed(request) {
      assertGatewayInput(request.configuration, request.inputs);
      const runner = runners.get(request.configuration.revisionPublicId)
        ?? createBoundedTaskRunner(request.configuration.concurrency, {
          minStartIntervalMs: request.configuration.minimumIntervalMs
        });
      runners.set(request.configuration.revisionPublicId, runner);
      const batches = chunk(request.inputs, request.configuration.batchSize);
      const responses = await Promise.all(batches.map((batch) => runner.run(() =>
        embedWithRetry(
          input.transport,
          request.configuration,
          batch,
          request.signal,
          delay,
          input.deploymentSecret
        )
      )));
      return responses.flatMap((response) =>
        response.vectors.map((vector) => normalizeVector(
          vector,
          request.configuration.normalization
        ))
      );
    }
  };
}

async function embedWithRetry(
  transport: EmbeddingTransport,
  configuration: EmbeddingConfigurationPrivate,
  inputs: readonly string[],
  signal: AbortSignal | null,
  delay: (milliseconds: number, signal: AbortSignal | null) => Promise<void>,
  deploymentSecret: string
): Promise<EmbeddingTransportResponse> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await transport.embed({
        baseUrl: configuration.baseUrl,
        authenticationMode: configuration.authenticationMode,
        apiKey: readApiKey(configuration, deploymentSecret),
        modelName: configuration.modelName,
        requestedDimension: configuration.requestedDimension,
        inputs,
        timeoutMs: configuration.timeoutMs,
        maximumResponseBytes: configuration.maximumResponseBytes,
        signal
      });
      if (
        configuration.resolvedDimension !== null
        && response.dimension !== configuration.resolvedDimension
      ) throw new EmbeddingTransportError("dimension_mismatch", false);
      return response;
    } catch (error) {
      if (
        !(error instanceof EmbeddingTransportError)
        || !error.retryable
        || attempt >= configuration.retryCount
      ) throw error;
      await delay(configuration.minimumIntervalMs, signal);
    }
  }
}

function assertGatewayInput(
  configuration: EmbeddingConfigurationPrivate,
  inputs: readonly string[]
): void {
  if (configuration.validationStatus !== "valid" || configuration.resolvedDimension === null) {
    throw new Error("Embedding configuration is not validated");
  }
  if (
    inputs.length === 0
    || inputs.some((value) =>
      !value
      || Buffer.byteLength(value) > configuration.maximumInputTokens * 4
    )
  ) throw new Error("Embedding input exceeds the configured bound");
}

function readApiKey(
  configuration: EmbeddingConfigurationPrivate,
  deploymentSecret: string
): string | null {
  if (configuration.authenticationMode === "none") return null;
  if (!configuration.encryptedApiKey) throw new Error("Embedding credential is unavailable");
  return decryptRuntimeSecret({
    value: configuration.encryptedApiKey,
    secret: deploymentSecret
  });
}

function normalizeVector(
  vector: readonly number[],
  normalization: "none" | "l2"
): readonly number[] {
  if (normalization === "none") return vector;
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    throw new EmbeddingTransportError("non_finite_vector", false);
  }
  return vector.map((value) => value / magnitude);
}

function chunk<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result;
}

async function abortableDelay(
  milliseconds: number,
  signal: AbortSignal | null
): Promise<void> {
  if (signal?.aborted) throw new EmbeddingTransportError("aborted", false);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new EmbeddingTransportError("aborted", false));
    }, { once: true });
  });
}
