import {
  MAXIMUM_SOURCE_METADATA_BYTES,
  analyzeOkfMetadata,
  measureSourceMetadataBytes,
  parseUploadedMarkdownSource,
  resolveSourceMetadata,
  type SourceMetadata,
  type SourceMetadataDefaults
} from "@focowiki/okf";
import type { StorageVnextStructuredMetadata } from "../shared/types.js";

export type StorageVnextSourceMetadataAnalysis = {
  body: string;
  metadata: StorageVnextStructuredMetadata;
  parsedMetadata: SourceMetadataDefaults;
  resolvedMetadata: SourceMetadata;
};

export function analyzeStorageVnextSourceMarkdown(input: {
  fileName: string;
  content: string;
}): StorageVnextSourceMetadataAnalysis {
  const parsed = parseUploadedMarkdownSource(input);
  const analysis = analyzeOkfMetadata(parsed.metadata, {
    ownership: "source",
    markdownBody: parsed.body
  });
  if (measureSourceMetadataBytes(analysis.metadata) > MAXIMUM_SOURCE_METADATA_BYTES) {
    throw sourceMetadataError("metadata_too_large");
  }
  const resolved = resolveSourceMetadata({
    ...input,
    metadata: parsed.metadata
  });
  return {
    body: resolved.body,
    metadata: analysis.metadata as StorageVnextStructuredMetadata,
    parsedMetadata: parsed.metadata,
    resolvedMetadata: resolved.metadata
  };
}

function sourceMetadataError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Storage vNext source metadata error: ${code}`),
    { code }
  );
}
