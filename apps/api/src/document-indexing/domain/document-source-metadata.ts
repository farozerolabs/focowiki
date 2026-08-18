import {
  MAXIMUM_SOURCE_METADATA_BYTES,
  analyzeOkfMetadata,
  measureSourceMetadataBytes,
  parseUploadedMarkdownSource,
  resolveSourceMetadata,
  type SourceMetadata,
  type SourceMetadataDefaults
} from "@focowiki/okf";

export type DocumentSourceMetadataAnalysis = {
  body: string;
  metadata: Record<string, unknown>;
  parsedMetadata: SourceMetadataDefaults;
  resolvedMetadata: SourceMetadata;
};

export function analyzeDocumentSourceMarkdown(input: {
  fileName: string;
  content: string;
}): DocumentSourceMetadataAnalysis {
  const parsed = parseUploadedMarkdownSource(input);
  const analysis = analyzeOkfMetadata(parsed.metadata, {
    ownership: "source",
    markdownBody: parsed.body
  });
  if (measureSourceMetadataBytes(analysis.metadata) > MAXIMUM_SOURCE_METADATA_BYTES) {
    throw documentMetadataError("metadata_too_large");
  }
  const resolved = resolveSourceMetadata({ ...input, metadata: parsed.metadata });
  return {
    body: resolved.body,
    metadata: analysis.metadata,
    parsedMetadata: parsed.metadata,
    resolvedMetadata: resolved.metadata
  };
}

function documentMetadataError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document source metadata error: ${code}`), { code });
}
