import { randomUUID } from "node:crypto";
import { mapWithConcurrency } from "../../runtime/bounded.js";
import type { BoundedTaskRunner } from "../../runtime/task-runner.js";
import {
  GRAPHRAG_REQUEST_SCHEMA,
  GraphRagAdapterError
} from "./contracts.js";
import type { GraphRagPythonPool } from "./python-pool.js";
import {
  createSemanticSourceChunks,
  semanticChunkManifestHash,
  type SemanticSourceChunk
} from "./source-chunks.js";
import {
  buildSemanticDesiredFactSet,
  type GraphRagExtractionRecordSet
} from "../domain/graph-normalization.js";
import type { SemanticDesiredFactSet } from "../domain/contracts.js";
import { SEMANTIC_PROMPT_CONTRACT_VERSION } from "../domain/contracts.js";
import {
  selectSemanticSkeleton,
  type SemanticSkeletonGraphSignals,
  type SemanticSkeletonSelection
} from "./skeleton-selector.js";

export type GraphRagModelCompletionPort = {
  complete(input: {
    prompt: string;
    signal: AbortSignal;
  }): Promise<string>;
};

export function createGraphRagExtractionGateway(input: {
  pool: GraphRagPythonPool;
  model: GraphRagModelCompletionPort;
  requestRunner?: BoundedTaskRunner;
  completionConcurrency?: number;
  maximumChunkCharacters?: number;
  maximumChunks?: number;
  retryAttempt?: number;
  adapterTimeoutMs?: number;
  now?: () => number;
  selectSkeleton?(input: {
    sourceRevisionPublicId: string;
    logicalPath: string;
    markdown: string;
    chunks: readonly SemanticSourceChunk[];
    graphSignals?: SemanticSkeletonGraphSignals;
  }): SemanticSkeletonSelection;
}) {
  const maximumChunkCharacters = input.maximumChunkCharacters ?? 2_000;
  const maximumChunks = input.maximumChunks ?? 32;
  const completionConcurrency = input.completionConcurrency ?? 1;
  const retryAttempt = input.retryAttempt ?? 1;
  const adapterTimeoutMs = input.adapterTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(completionConcurrency)
    || completionConcurrency < 1 || completionConcurrency > 32) {
    throw new Error("GraphRAG completion concurrency is invalid");
  }
  if (!Number.isSafeInteger(retryAttempt) || retryAttempt < 1 || retryAttempt > 100) {
    throw new Error("GraphRAG retry attempt is invalid");
  }
  return {
    async extract(request: {
      knowledgeBaseId: string;
      semanticGenerationPublicId: string;
      sourceFilePublicId: string;
      sourceRevisionPublicId: string;
      logicalPath: string;
      markdown: string;
      skeletonGraphSignals?: SemanticSkeletonGraphSignals;
      signal: AbortSignal;
    }): Promise<{
      desiredFacts: SemanticDesiredFactSet;
      chunks: readonly SemanticSourceChunk[];
      selection: SemanticSkeletonSelection;
      promptRevision: string;
      canonicalInputHash: string;
      generationRequestCount: number;
      generationServiceTimeMilliseconds: number;
    }> {
      throwIfAborted(request.signal);
      const effectiveMaximumChunkCharacters = retryChunkCharacters({
        configuredMaximum: maximumChunkCharacters,
        maximumChunks,
        sourceCharacters: request.markdown.length,
        retryAttempt
      });
      const chunks = createSemanticSourceChunks({
        sourceRevisionPublicId: request.sourceRevisionPublicId,
        markdown: request.markdown,
        maximumChunkCharacters: effectiveMaximumChunkCharacters,
        maximumChunks
      });
      const canonicalInputHash = semanticChunkManifestHash(chunks);
      const selection = validateSelection(
        (input.selectSkeleton ?? selectSemanticSkeleton)({
          sourceRevisionPublicId: request.sourceRevisionPublicId,
          logicalPath: request.logicalPath,
          markdown: request.markdown,
          chunks,
          ...(request.skeletonGraphSignals
            ? { graphSignals: request.skeletonGraphSignals }
            : {})
        }),
        chunks
      );
      if (!selection.selected) {
        return {
          desiredFacts: buildSemanticDesiredFactSet({
            knowledgeBaseId: request.knowledgeBaseId,
            semanticGenerationPublicId: request.semanticGenerationPublicId,
            sourceFilePublicId: request.sourceFilePublicId,
            sourceRevisionPublicId: request.sourceRevisionPublicId,
            logicalPath: request.logicalPath,
            chunks: [],
            extraction: { entities: [], mentions: [], relationships: [] }
          }),
          chunks,
          selection,
          promptRevision: SEMANTIC_PROMPT_CONTRACT_VERSION,
          canonicalInputHash,
          generationRequestCount: 0,
          generationServiceTimeMilliseconds: 0
        };
      }
      const selectedChunkIds = new Set(selection.selectedChunkIds);
      const selectedChunks = chunks.filter((chunk) => selectedChunkIds.has(chunk.id));
      const selectedInputHash = semanticChunkManifestHash(selectedChunks);
      const source = {
        sourceFileId: request.sourceFilePublicId,
        sourceRevisionId: request.sourceRevisionPublicId,
        chunks: selectedChunks.map(({ id, text }) => ({ id, text })),
        canonicalInputHash: selectedInputHash
      };
      const prepared = await runAdapter(input.pool, {
        schemaVersion: GRAPHRAG_REQUEST_SCHEMA,
        requestId: `prepare-${randomUUID()}`,
        operation: "prepare",
        knowledgeBaseId: request.knowledgeBaseId,
        source,
        limits: adapterLimits(maximumChunks, effectiveMaximumChunkCharacters)
      }, adapterTimeoutMs, request.signal);
      const preparation = parsePreparation(prepared, selectedChunks, selectedInputHash);
      const generationServiceTimes: number[] = [];
      const now = input.now ?? Date.now;
      const modelOutputs = await mapWithConcurrency(
        preparation.prompts,
        completionConcurrency,
        async (prompt) => {
        throwIfAborted(request.signal);
        const operation = async () => {
          const startedAt = now();
          try {
            return await input.model.complete({
              prompt: prompt.prompt,
              signal: request.signal
            });
          } finally {
            generationServiceTimes.push(elapsedMilliseconds(startedAt, now()));
          }
        };
        const output = input.requestRunner
          ? await input.requestRunner.run(operation)
          : await operation();
        if (!output || output.length > 256_000) {
          throw extractionError("semantic_model_output_invalid", false);
        }
        return output;
      });
      const extracted = await runAdapter(input.pool, {
        schemaVersion: GRAPHRAG_REQUEST_SCHEMA,
        requestId: `extract-${randomUUID()}`,
        operation: "extract",
        knowledgeBaseId: request.knowledgeBaseId,
        source,
        modelOutputs,
        limits: adapterLimits(maximumChunks, effectiveMaximumChunkCharacters)
      }, adapterTimeoutMs, request.signal);
      const extraction = parseExtraction(extracted);
      return {
        desiredFacts: buildSemanticDesiredFactSet({
          knowledgeBaseId: request.knowledgeBaseId,
          semanticGenerationPublicId: request.semanticGenerationPublicId,
          sourceFilePublicId: request.sourceFilePublicId,
          sourceRevisionPublicId: request.sourceRevisionPublicId,
          logicalPath: request.logicalPath,
          chunks: selectedChunks.map((chunk) => ({
            evidenceId: chunk.id,
            text: chunk.text,
            startOffset: chunk.startOffset,
            endOffset: chunk.endOffset
          })),
          extraction
        }),
        chunks,
        selection,
        promptRevision: preparation.promptRevision,
        canonicalInputHash,
        generationRequestCount: modelOutputs.length,
        generationServiceTimeMilliseconds: generationServiceTimes.reduce(
          (sum, value) => sum + value,
          0
        )
      };
    }
  };
}

function elapsedMilliseconds(startedAt: number, endedAt: number): number {
  const elapsed = Math.round(endedAt - startedAt);
  if (!Number.isSafeInteger(elapsed) || elapsed < 0) {
    throw extractionError("semantic_generation_timing_invalid", false);
  }
  return elapsed;
}

function validateSelection(
  selection: SemanticSkeletonSelection,
  chunks: readonly SemanticSourceChunk[]
): SemanticSkeletonSelection {
  const availableIds = new Set(chunks.map((chunk) => chunk.id));
  const selectedIds = [...selection.selectedChunkIds];
  if (!selection.policyVersion || selection.policyVersion.length > 128
    || selection.sourceChunkCount !== chunks.length
    || !/^[0-9a-f]{64}$/u.test(selection.decisionSha256)
    || new Set(selectedIds).size !== selectedIds.length
    || selectedIds.some((id) => !availableIds.has(id))
    || selection.selected !== (selectedIds.length > 0)
    || selectedIds.length > 8) {
    throw extractionError("semantic_skeleton_selection_invalid", false);
  }
  return Object.freeze({
    ...selection,
    selectedChunkIds: Object.freeze(selectedIds),
    reasons: Object.freeze([...selection.reasons])
  });
}

function retryChunkCharacters(input: {
  configuredMaximum: number;
  maximumChunks: number;
  sourceCharacters: number;
  retryAttempt: number;
}): number {
  const divisor = 2 ** Math.min(input.retryAttempt - 1, 16);
  const retryMaximum = Math.max(1, Math.floor(input.configuredMaximum / divisor));
  const coverageMinimum = Math.max(
    1,
    Math.ceil(input.sourceCharacters / input.maximumChunks)
  );
  return Math.min(
    input.configuredMaximum,
    Math.max(retryMaximum, coverageMinimum)
  );
}

async function runAdapter(
  pool: GraphRagPythonPool,
  request: Parameters<GraphRagPythonPool["run"]>[0],
  timeoutMs: number,
  signal: AbortSignal
): Promise<Record<string, unknown>> {
  const response = await pool.run(request, { timeoutMs, signal });
  if (!response.ok) {
    throw new GraphRagAdapterError(
      response.error?.code ?? "ADAPTER_REQUEST_FAILED",
      response.error?.message ?? "GraphRAG adapter request failed"
    );
  }
  return response.result ?? {};
}

function parsePreparation(
  value: Record<string, unknown>,
  chunks: readonly SemanticSourceChunk[],
  canonicalInputHash: string
): { promptRevision: string; prompts: Array<{ chunkId: string; prompt: string }> } {
  const promptRevision = boundedString(value.promptRevision, 128);
  const prompts = Array.isArray(value.prompts) ? value.prompts : [];
  if (value.canonicalInputHash !== canonicalInputHash || prompts.length !== chunks.length) {
    throw extractionError("semantic_prompt_manifest_invalid", false);
  }
  const expectedIds = chunks.map((chunk) => chunk.id);
  const parsed = prompts.map((item, index) => {
    const record = object(item);
    const chunkId = boundedString(record.chunkId, 255);
    const prompt = boundedString(record.prompt, 128_000);
    if (chunkId !== expectedIds[index]) {
      throw extractionError("semantic_prompt_manifest_invalid", false);
    }
    return { chunkId, prompt };
  });
  return { promptRevision, prompts: parsed };
}

function parseExtraction(value: Record<string, unknown>): GraphRagExtractionRecordSet {
  const entities = array(value.entities, 2_000);
  const mentions = array(value.mentions, 4_000);
  const relationships = array(value.relationships, 4_000);
  return {
    entities: entities as GraphRagExtractionRecordSet["entities"],
    mentions: mentions as GraphRagExtractionRecordSet["mentions"],
    relationships: relationships as GraphRagExtractionRecordSet["relationships"]
  };
}

function adapterLimits(maximumChunks: number, maximumChunkCharacters: number) {
  return {
    maximum_chunks: maximumChunks,
    maximum_chunk_characters: maximumChunkCharacters,
    maximum_model_output_characters: 256_000,
    maximum_entities: 2_000,
    maximum_relationships: 4_000,
    maximum_field_characters: 16_000,
    maximum_edges_for_community: 10_000,
    maximum_community_size: 100
  };
}

function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum
    || value.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
    throw extractionError("semantic_adapter_output_invalid", false);
  }
  return value;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw extractionError("semantic_adapter_output_invalid", false);
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum) {
    throw extractionError("semantic_adapter_output_invalid", false);
  }
  return value;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException("Semantic extraction aborted", "AbortError");
  }
}

function extractionError(code: string, retryable: boolean): Error & {
  code: string;
  retryable: boolean;
} {
  return Object.assign(new Error(`Semantic extraction failed: ${code}`), {
    code,
    retryable
  });
}
