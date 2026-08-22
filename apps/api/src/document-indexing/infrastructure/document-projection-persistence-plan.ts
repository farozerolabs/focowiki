import type { LexicalTokenizer } from
  "../../application/ports/lexical-tokenizer.js";
import { selectDocumentNavigationTerms } from
  "../application/document-navigation-terms.js";
import { documentSourcePagePath } from
  "../application/document-machine-record.js";
import { posix } from "node:path";

export function buildDocumentProjectionFact(input: {
  knowledgeBaseId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  source: {
    normalizedPath: string;
    contentType: string;
  };
  base: {
    logicalPath: string;
    title: string;
    body: string;
    metadata: Readonly<Record<string, unknown>>;
    semanticEntities: readonly { label: string }[];
  };
  generatedPage: {
    logicalPath: string;
    checksumSha256: string;
    byteCount: number;
  };
  tokenizer: LexicalTokenizer;
  relationPublicIds: readonly string[];
  relations: readonly {
    publicId: string;
    evidence: { sourceFilePublicId: string };
  }[];
}) {
  const navigationTerms = selectDocumentNavigationTerms({
    path: documentSourcePagePath(input.base.logicalPath),
    title: input.base.title,
    aliases: metadataStringValues(input.base.metadata, ["aliases"]),
    headings: markdownHeadings(input.base.body),
    metadata: metadataStringValues(input.base.metadata, [
      "tags", "subjects", "title", "description", "type", "language"
    ]),
    entities: input.base.semanticEntities.map((entity) => entity.label),
    modelKeywords: metadataStringValues(input.base.metadata, ["keywords"]),
    body: input.base.body
  }, input.tokenizer);
  const incoming = input.relationPublicIds.filter((publicId) =>
    input.relations.some((relation) => relation.publicId === publicId
      && relation.evidence.sourceFilePublicId !== input.sourceFilePublicId));
  const outgoing = input.relationPublicIds.filter((publicId) =>
    input.relations.some((relation) => relation.publicId === publicId
      && relation.evidence.sourceFilePublicId === input.sourceFilePublicId));
  const pagePath = documentSourcePagePath(input.base.logicalPath);
  if (input.generatedPage.logicalPath !== pagePath
    || !/^[0-9a-f]{64}$/u.test(input.generatedPage.checksumSha256)
    || !Number.isSafeInteger(input.generatedPage.byteCount)
    || input.generatedPage.byteCount < 0) {
    throw new Error("document_projection_generated_page_invalid");
  }
  return {
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFilePublicId: input.sourceFilePublicId,
    sourceRevisionPublicId: input.sourceRevisionPublicId,
    logicalPath: input.base.logicalPath,
    normalizedPath: input.source.normalizedPath,
    pagePath,
    title: input.base.title,
    summary: input.base.body.replace(/\s+/gu, " ").trim().slice(0, 240),
    metadata: input.base.metadata,
    headings: markdownHeadings(input.base.body),
    entities: input.base.semanticEntities.map((entity) => entity.label),
    contentType: input.source.contentType,
    checksumSha256: input.generatedPage.checksumSha256,
    byteCount: input.generatedPage.byteCount,
    tokenizerContractVersion: input.tokenizer.contractVersion,
    navigationTermFingerprintSha256: navigationTerms.fingerprint,
    navigationTerms: navigationTerms.terms,
    directoryPaths: pageDirectoryAncestors(pagePath),
    incomingRelationshipCount: new Set(incoming).size,
    outgoingRelationshipCount: new Set(outgoing).size
  };
}

function metadataStringValues(
  metadata: Readonly<Record<string, unknown>>,
  keys: readonly string[]
): string[] {
  return keys.flatMap((key) => {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return [value.trim()];
    if (Array.isArray(value)) return value.filter((item): item is string =>
      typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim());
    return [];
  });
}

function markdownHeadings(body: string): string[] {
  return body.split("\n").flatMap((line) => {
    const heading = /^#{1,6}\s+(.+)$/u.exec(line)?.[1]?.trim();
    return heading ? [heading] : [];
  }).slice(0, 128);
}

function pageDirectoryAncestors(pagePath: string): string[] {
  const directories = [posix.dirname(pagePath)];
  while (directories.at(-1) !== "pages") {
    directories.push(posix.dirname(directories.at(-1)!));
  }
  return directories.reverse();
}
