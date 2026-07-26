import type {
  LexicalRebuildProjectionResult
} from "../application/ports/lexical-rebuild-work-repository.js";
import { parseUploadedMarkdownSource } from "@focowiki/okf";
import type { LexicalTokenizer } from "../application/ports/lexical-tokenizer.js";
import { createGraphNode } from "../graph/graph-node-profile.js";
import { buildGraphTermDocument } from "../graph/graph-term-document.js";
import { buildBodySearchDocument } from "../search/body-search-document.js";
import type { LexicalSourceRead } from "./lexical-source-reader.js";

export function deriveLexicalProjections(input: {
  read: LexicalSourceRead;
  tokenizer: LexicalTokenizer;
}): LexicalRebuildProjectionResult {
  const source = input.read.source;
  const parsed = parseUploadedMarkdownSource({
    fileName: source.relativePath,
    content: input.read.body
  });
  const node = createGraphNode({
    sourceFileId: source.sourceFileId,
    sourceRelativePath: source.relativePath,
    metadata: source.metadata,
    body: parsed.body,
    suggestions: source.suggestions,
    tokenizer: input.tokenizer
  });
  const summary = node.summary ?? node.description ?? source.summary;
  const searchDocument = buildBodySearchDocument({
    knowledgeBaseId: source.knowledgeBaseId,
    sourceFileId: source.sourceFileId,
    sourceRevisionId: source.sourceRevisionId,
    sourceBodyChecksumSha256: source.checksumSha256,
    title: node.title,
    logicalPath: source.logicalPath,
    summary,
    body: parsed.body,
    tokenizer: input.tokenizer
  });
  const graphTermDocument = buildGraphTermDocument({
    sourceFileId: source.sourceFileId,
    sourceRevisionId: source.sourceRevisionId,
    title: node.title,
    body: parsed.body,
    headings: node.headings ?? [],
    phrases: readProfileTerms(node.metadata ?? {}, "evidencePhrases"),
    entities: node.entities ?? [],
    explicitReferences: node.explicitReferences ?? [],
    supplementalTerms: [
      ...(node.subjects ?? []),
      ...(node.tags ?? []),
      ...(node.keywords ?? []),
      ...(node.relationshipHints ?? [])
    ],
    tokenizer: input.tokenizer
  });

  return {
    claim: source,
    sourceUrl: source.sourceUrl,
    metadata: node.metadata ?? {},
    searchDocument,
    graphNode: node,
    graphTermDocument,
    sourceReadBytes: input.read.bytes,
    sourceReadLatencyMs: input.read.latencyMs,
    sourceReadRetries: input.read.retryCount
  };
}

function readProfileTerms(metadata: Record<string, unknown>, key: string): string[] {
  const profile = metadata.contentProfile;
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return [];
  const value = (profile as Record<string, unknown>)[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
