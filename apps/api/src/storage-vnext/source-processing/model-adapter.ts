import {
  type SourceMetadata,
  type SourceMetadataDefaults,
  type SourceModelSuggestions
} from "@focowiki/okf";
import type {
  StorageVnextGraphEdgeFact,
  StorageVnextGraphNodeFact
} from "../graph/ports.js";
import type { StorageVnextSourceModelPort } from "./ports.js";
import { analyzeStorageVnextSourceMarkdown } from "./source-metadata.js";

type SourceSuggestionInput = {
  knowledgeBaseId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  attemptPublicId: string;
  fileName: string;
  title: string;
  type: string;
  tags: string[];
  body: string;
  signal: AbortSignal;
};

type SourceSuggestionResult = {
  suggestions: SourceModelSuggestions | null;
  warningCount: number;
};

type SourceGraphExtractionInput = {
  knowledgeBaseId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  sourceLogicalPath: string;
  checksum: string;
  revision: number;
  parsedMetadata: SourceMetadataDefaults;
  resolvedMetadata: SourceMetadata;
  suggestions: SourceModelSuggestions | null;
  modelAssistanceSelected: boolean;
  body: string;
  sourceBody: string;
  signal: AbortSignal;
};

export function createStorageVnextSourceModelAdapter(input: {
  selectModelAssistance?: (request: {
    knowledgeBaseId: string;
    sourceFilePublicId: string;
    sourceRevisionPublicId: string;
    sourceLogicalPath: string;
    markdown: string;
    signal: AbortSignal;
  }) => Promise<boolean>;
  suggest?: (request: SourceSuggestionInput) => Promise<SourceSuggestionResult>;
  extractGraph(request: SourceGraphExtractionInput): Promise<{
    node: StorageVnextGraphNodeFact;
    edges: readonly StorageVnextGraphEdgeFact[];
    modelWarningCount?: number;
  }>;
}): StorageVnextSourceModelPort {
  return {
    async extract(request) {
      throwIfAborted(request.signal);
      assertRequestIdentity(request);
      const source = await readSourceBody(request.body, request.signal);
      const fileName = request.sourceFile.logicalPath.split("/").at(-1) ?? "";
      const analyzed = analyzeStorageVnextSourceMarkdown({
        fileName,
        content: source
      });
      throwIfAborted(request.signal);
      const modelAssistanceSelected = input.selectModelAssistance
        ? await input.selectModelAssistance({
            knowledgeBaseId: request.knowledgeBaseId,
            sourceFilePublicId: request.sourceFile.publicId,
            sourceRevisionPublicId: request.sourceRevisionPublicId,
            sourceLogicalPath: request.sourceFile.logicalPath,
            markdown: source,
            signal: request.signal
          })
        : true;
      if (typeof modelAssistanceSelected !== "boolean") {
        throw sourceModelError("invalid_model_assistance_selection");
      }
      throwIfAborted(request.signal);
      const modelAssistanceUsed = modelAssistanceSelected && Boolean(input.suggest);
      if (modelAssistanceUsed) await request.onModelAssistanceStart?.();
      const suggestionResult = modelAssistanceUsed
        ? await input.suggest!({
            knowledgeBaseId: request.knowledgeBaseId,
            sourceFilePublicId: request.sourceFile.publicId,
            sourceRevisionPublicId: request.sourceRevisionPublicId,
            attemptPublicId: request.attemptPublicId,
            fileName,
            title: analyzed.resolvedMetadata.title,
            type: analyzed.resolvedMetadata.type,
            tags: analyzed.resolvedMetadata.tags ?? [],
            body: analyzed.body,
            signal: request.signal
          })
        : { suggestions: null, warningCount: 0 };
      assertWarningCount(suggestionResult.warningCount);
      throwIfAborted(request.signal);
      const graph = await input.extractGraph({
        knowledgeBaseId: request.knowledgeBaseId,
        sourceFilePublicId: request.sourceFile.publicId,
        sourceRevisionPublicId: request.sourceRevisionPublicId,
        sourceLogicalPath: request.sourceFile.logicalPath,
        checksum: request.sourceRevision.checksum,
        revision: request.sourceFile.revision,
        parsedMetadata: analyzed.parsedMetadata,
        resolvedMetadata: analyzed.resolvedMetadata,
        suggestions: suggestionResult.suggestions,
        modelAssistanceSelected,
        body: analyzed.body,
        sourceBody: source,
        signal: request.signal
      });
      const graphWarningCount = graph.modelWarningCount ?? 0;
      assertWarningCount(graphWarningCount);
      return {
        metadata: analyzed.metadata,
        node: graph.node,
        edges: graph.edges,
        modelAssistanceUsed,
        modelWarningCount: Math.min(1_000, suggestionResult.warningCount + graphWarningCount)
      };
    }
  };
}

function assertWarningCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000) {
    throw sourceModelError("invalid_model_warning_count");
  }
}

async function readSourceBody(
  body: AsyncIterable<Uint8Array>,
  signal: AbortSignal
): Promise<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const parts: string[] = [];
  for await (const chunk of body) {
    throwIfAborted(signal);
    parts.push(decoder.decode(chunk, { stream: true }));
  }
  parts.push(decoder.decode());
  throwIfAborted(signal);
  return parts.join("");
}

function assertRequestIdentity(
  request: Parameters<StorageVnextSourceModelPort["extract"]>[0]
): void {
  if (
    request.sourceFile.knowledgeBaseId !== request.knowledgeBaseId
    || request.sourceRevision.knowledgeBaseId !== request.knowledgeBaseId
    || request.sourceRevision.sourceFilePublicId !== request.sourceFile.publicId
    || request.sourceRevision.publicId !== request.sourceRevisionPublicId
    || request.sourceFile.currentRevisionPublicId !== request.sourceRevisionPublicId
  ) throw sourceModelError("identity_conflict");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException("Source model request aborted", "AbortError");
  }
}

function sourceModelError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Storage vNext source model adapter error: ${code}`), { code });
}
