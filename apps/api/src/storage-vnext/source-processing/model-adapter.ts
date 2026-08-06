import {
  parseUploadedMarkdownSource,
  resolveSourceMetadata,
  type SourceMetadata,
  type SourceMetadataDefaults,
  type SourceModelSuggestions
} from "@focowiki/okf";
import type {
  StorageVnextGraphEdgeFact,
  StorageVnextGraphNodeFact
} from "../graph/ports.js";
import type { StorageVnextStructuredMetadata } from "../shared/types.js";
import type { StorageVnextSourceModelPort } from "./ports.js";

const MAXIMUM_METADATA_BYTES = 8_192;

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
  body: string;
  sourceBody: string;
  signal: AbortSignal;
};

export function createStorageVnextSourceModelAdapter(input: {
  suggest?: (request: SourceSuggestionInput) => Promise<SourceModelSuggestions | null>;
  extractGraph(request: SourceGraphExtractionInput): Promise<{
    node: StorageVnextGraphNodeFact;
    edges: readonly StorageVnextGraphEdgeFact[];
  }>;
}): StorageVnextSourceModelPort {
  return {
    async extract(request) {
      throwIfAborted(request.signal);
      assertRequestIdentity(request);
      const source = await readSourceBody(request.body, request.signal);
      const fileName = request.sourceFile.logicalPath.split("/").at(-1) ?? "";
      const parsed = parseUploadedMarkdownSource({ fileName, content: source });
      const resolved = resolveSourceMetadata({
        fileName,
        content: source,
        metadata: parsed.metadata
      });
      const metadata = toBoundedMetadata(resolved.metadata);
      throwIfAborted(request.signal);
      const suggestions = input.suggest
        ? await input.suggest({
            knowledgeBaseId: request.knowledgeBaseId,
            sourceFilePublicId: request.sourceFile.publicId,
            sourceRevisionPublicId: request.sourceRevisionPublicId,
            attemptPublicId: request.attemptPublicId,
            fileName,
            title: resolved.metadata.title,
            type: resolved.metadata.type,
            tags: resolved.metadata.tags ?? [],
            body: resolved.body,
            signal: request.signal
          })
        : null;
      throwIfAborted(request.signal);
      const graph = await input.extractGraph({
        knowledgeBaseId: request.knowledgeBaseId,
        sourceFilePublicId: request.sourceFile.publicId,
        sourceRevisionPublicId: request.sourceRevisionPublicId,
        sourceLogicalPath: request.sourceFile.logicalPath,
        checksum: request.sourceRevision.checksum,
        revision: request.sourceFile.revision,
        parsedMetadata: parsed.metadata,
        resolvedMetadata: resolved.metadata,
        suggestions,
        body: resolved.body,
        sourceBody: source,
        signal: request.signal
      });
      return { metadata, node: graph.node, edges: graph.edges };
    }
  };
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

function toBoundedMetadata(metadata: SourceMetadata): StorageVnextStructuredMetadata {
  const serialized = JSON.stringify(metadata);
  if (Buffer.byteLength(serialized, "utf8") > MAXIMUM_METADATA_BYTES) {
    throw sourceModelError("metadata_too_large");
  }
  return metadata as StorageVnextStructuredMetadata;
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
