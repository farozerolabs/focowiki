import type { LexicalTokenizer } from
  "../../application/ports/lexical-tokenizer.js";
import { collectDocumentGeneratedLinkPaths,
  validateDocumentGeneratedLinks,
  validateDocumentProgressiveNavigation } from
  "../application/document-generated-link-validation.js";
import { selectDocumentNavigationTerms } from
  "../application/document-navigation-terms.js";
import { validateDocumentOkfMarkdownMetadata } from
  "../application/document-okf-validation.js";
import { collectDocumentPortableReferencedPagePaths,
  validateDocumentPortableCandidate } from
  "../application/document-portable-candidate-validation.js";
import { documentSourcePagePath } from
  "../application/document-machine-record.js";
import type { createPostgresGeneratedPageRepository } from
  "./postgres-generated-page-repository.js";
import { documentProjectionHeadLookupPaths } from
  "./document-knowledge-projection-support.js";
import { normalizeLogicalPath } from
  "./production-document-processor-support.js";
import { posix } from "node:path";

type DesiredPage = Readonly<{
  logicalPath: string;
  normalizedPath: string;
  entryKind: string;
  bytes: Uint8Array;
  checksumSha256: string;
  byteCount: number;
  sourceFilePublicId: string | null;
  sourceRevisionPublicId: string | null;
}>;

export async function readDocumentProjectionPersistenceState(input: {
  pages: ReturnType<typeof createPostgresGeneratedPageRepository>;
  knowledgeBaseId: string;
  sourceFilePublicId: string;
  desiredPages: readonly DesiredPage[];
  removedPaths: readonly string[];
}) {
  for (const page of input.desiredPages) {
    if (!page.normalizedPath.endsWith(".md")) continue;
    validateDocumentOkfMarkdownMetadata({
      logicalPath: page.logicalPath,
      kind: page.entryKind,
      body: new TextDecoder().decode(page.bytes)
    });
  }
  const priorSourceHeads = await input.pages.readSourceHeads({
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFilePublicId: input.sourceFilePublicId,
    limit: 1
  });
  const affectedPaths = [...new Set([
    ...input.desiredPages.map((page) => page.normalizedPath),
    ...priorSourceHeads.map((page) => page.normalizedPath),
    ...input.removedPaths.map(normalizeLogicalPath)
  ])].sort();
  const currentHeads = await input.pages.readHeads({
    knowledgeBaseId: input.knowledgeBaseId,
    normalizedPaths: affectedPaths,
    limit: Math.max(1, affectedPaths.length)
  });
  const validationPages = input.desiredPages.map((page) => ({
    logicalPath: page.logicalPath,
    bytes: page.bytes,
    allowUnresolved: page.entryKind === "source",
    contentType: page.normalizedPath.endsWith(".json")
      ? "application/json; charset=utf-8"
      : "text/markdown; charset=utf-8"
  }));
  const linked = [...new Set([
    ...collectDocumentGeneratedLinkPaths(validationPages),
    ...collectDocumentPortableReferencedPagePaths(input.desiredPages)
  ])];
  const linkedHeads = await input.pages.readHeads({
    knowledgeBaseId: input.knowledgeBaseId,
    normalizedPaths: documentProjectionHeadLookupPaths(linked),
    limit: Math.max(1, linked.length)
  });
  const activeLogicalPaths = linkedHeads.map((head) => head.logicalPath);
  validateDocumentGeneratedLinks({ pages: validationPages, activeLogicalPaths });
  validateDocumentProgressiveNavigation({
    pages: validationPages,
    activeLogicalPaths
  });
  validateDocumentPortableCandidate({
    pages: input.desiredPages,
    activeReadablePagePaths: activeLogicalPaths
  });
  return { affectedPaths, currentHeads };
}

export function buildDocumentProjectionFact(input: {
  knowledgeBaseId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  source: {
    normalizedPath: string;
    contentType: string;
    checksumSha256: string;
    byteCount: number;
  };
  base: {
    logicalPath: string;
    title: string;
    body: string;
    metadata: Readonly<Record<string, unknown>>;
    semanticEntities: readonly { label: string }[];
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
    checksumSha256: input.source.checksumSha256,
    byteCount: input.source.byteCount,
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
