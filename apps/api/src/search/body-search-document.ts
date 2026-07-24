import { createHash } from "node:crypto";
import type { LexicalTokenizer } from "../application/ports/lexical-tokenizer.js";
import {
  BODY_SEGMENTATION_VERSION,
  segmentMarkdownBody
} from "./body-segmentation.js";

export const BODY_SEARCH_SCHEMA_VERSION = "body-search-v1";
export const BODY_SEARCH_SEGMENT_TOKEN_LIMIT = 256;

export type BodySearchSegment = {
  ordinal: number;
  heading: string | null;
  normalizedText: string;
  tokens: string[];
};

export type BodySearchDocument = {
  documentId: string;
  knowledgeBaseId: string;
  sourceFileId: string;
  sourceRevisionId: string;
  sourceBodyChecksumSha256: string;
  searchSchemaVersion: string;
  tokenizerContractVersion: string;
  segmentationVersion: string;
  title: string;
  logicalPath: string;
  summary: string | null;
  segments: BodySearchSegment[];
};

export function buildBodySearchDocument(input: {
  knowledgeBaseId: string;
  sourceFileId: string;
  sourceRevisionId: string;
  sourceBodyChecksumSha256: string;
  title: string;
  logicalPath: string;
  summary: string | null;
  body: string;
  tokenizer: LexicalTokenizer;
}): BodySearchDocument {
  const documentId = createBodySearchDocumentId({
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFileId: input.sourceFileId,
    sourceBodyChecksumSha256: input.sourceBodyChecksumSha256,
    searchSchemaVersion: BODY_SEARCH_SCHEMA_VERSION,
    tokenizerContractVersion: input.tokenizer.contractVersion
  });
  const segments = segmentMarkdownBody(input.body).map((segment) => ({
    ordinal: segment.ordinal,
    heading: segment.heading,
    normalizedText: segment.text,
    tokens: input.tokenizer.tokenizeDocument(
      [segment.heading, segment.text].filter(Boolean).join("\n"),
      BODY_SEARCH_SEGMENT_TOKEN_LIMIT
    )
  }));

  return {
    documentId,
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFileId: input.sourceFileId,
    sourceRevisionId: input.sourceRevisionId,
    sourceBodyChecksumSha256: input.sourceBodyChecksumSha256,
    searchSchemaVersion: BODY_SEARCH_SCHEMA_VERSION,
    tokenizerContractVersion: input.tokenizer.contractVersion,
    segmentationVersion: BODY_SEGMENTATION_VERSION,
    title: input.title,
    logicalPath: input.logicalPath,
    summary: input.summary,
    segments
  };
}

export function createBodySearchDocumentId(input: {
  knowledgeBaseId: string;
  sourceFileId: string;
  sourceBodyChecksumSha256: string;
  searchSchemaVersion: string;
  tokenizerContractVersion: string;
}): string {
  const digest = createHash("sha256")
    .update([
      input.knowledgeBaseId,
      input.sourceFileId,
      input.sourceBodyChecksumSha256,
      input.searchSchemaVersion,
      input.tokenizerContractVersion
    ].join("\u0000"))
    .digest("hex");
  return `search-document-${digest}`;
}
