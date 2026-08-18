import {
  assertPortableRecord,
  normalizePortablePagePath,
  portableByFileGraphPath,
  type PortableEvidence
} from "@focowiki/okf";
import { selectDocumentNavigationTerms } from
  "./document-navigation-terms.js";
import type { DocumentNavigationTerm } from
  "./document-navigation-terms.js";

const NAVIGATION_TERMS = Symbol("document-navigation-terms");
export type DocumentSourceProjectionRecord = Record<string, unknown> & {
  [NAVIGATION_TERMS]?: readonly DocumentNavigationTerm[];
};
type DocumentNavigationTokenizer = Parameters<
  typeof selectDocumentNavigationTerms
>[1];

export type DocumentProjectionSource = Readonly<{
  path: string;
  title: string;
  body: string;
  contentType: string;
  checksumSha256: string;
  byteCount: number;
  metadata: Readonly<Record<string, unknown>>;
  entities: readonly string[];
}>;

export type DocumentProjectionRelation = Readonly<{
  fromPath: string;
  toPath: string;
  fromTitle: string;
  toTitle: string;
  relationType: "references" | "related";
  evidenceKind: "markdown_link" | "okf_metadata" | "stable_alias" | "semantic";
  evidenceValue: Readonly<Record<string, unknown>>;
}>;

export function documentSourcePagePath(logicalPath: string): string {
  return normalizePortablePagePath(logicalPath);
}

export function documentSourceProjectionRecord(
  source: DocumentProjectionSource,
  tokenizer: DocumentNavigationTokenizer,
  options: Readonly<{ hasRelationships?: boolean }> = {}
): DocumentSourceProjectionRecord {
  const path = documentSourcePagePath(source.path);
  const headingsValue = headings(source.body);
  const tags = metadataStrings(source, "tags");
  const subjects = metadataStrings(source, "subjects");
  const keywords = metadataStrings(source, "keywords");
  const termSelection = selectDocumentNavigationTerms({
    path,
    title: source.title,
    aliases: metadataValues(source.metadata, ["aliases"]),
    metadata: metadataValues(source.metadata, [
      "tags", "subjects", "title", "description", "type", "language"
    ]),
    body: source.body,
    headings: headingsValue,
    entities: source.entities,
    modelKeywords: keywords
  }, tokenizer);
  const record: DocumentSourceProjectionRecord = {
    path,
    title: source.title,
    summary: source.body.replace(/\s+/gu, " ").trim().slice(0, 240),
    type: metadataString(source, "type") ?? "document",
    ...(metadataString(source, "description")
      ? { description: metadataString(source, "description") } : {}),
    ...(metadataString(source, "resource")
      ? { resource: metadataString(source, "resource") } : {}),
    ...(metadataString(source, "timestamp")
      ? { timestamp: metadataString(source, "timestamp") } : {}),
    subjects,
    tags,
    metadata: source.metadata,
    headings: headingsValue,
    keywords,
    ...(metadataString(source, "language")
      ? { language: metadataString(source, "language") } : {}),
    entities: [...new Set(source.entities.map((value) => value.trim())
      .filter(Boolean))].sort(compareText),
    contentType: source.contentType,
    checksumSha256: source.checksumSha256,
    byteCount: source.byteCount,
    relationshipCount: options.hasRelationships === true ? 1 : 0,
    ...(options.hasRelationships === true
      ? { graphPath: portableByFileGraphPath(path) } : {})
  };
  Object.defineProperty(record, NAVIGATION_TERMS, {
    value: termSelection.terms,
    enumerable: false,
    configurable: false,
    writable: false
  });
  assertPortableRecord("document_packet", {
    formatVersion: 2,
    title: "Document records",
    scopePath: path.slice(0, path.lastIndexOf("/")),
    documents: [record]
  });
  return record;
}

export function documentProjectionNavigationTerms(
  record: Readonly<Record<string, unknown>>
): readonly DocumentNavigationTerm[] {
  return (record as DocumentSourceProjectionRecord)[NAVIGATION_TERMS] ?? [];
}

export function documentRelationProjectionRecord(
  relation: DocumentProjectionRelation
): Record<string, unknown> {
  return {
    from: documentSourcePagePath(relation.fromPath),
    to: documentSourcePagePath(relation.toPath),
    fromTitle: relation.fromTitle,
    toTitle: relation.toTitle,
    direction: "outgoing",
    relationType: relation.relationType,
    weight: 1,
    reason: relationReason(relation),
    evidence: portableEvidence(relation)
  };
}

export function documentRelatedProjectionRecord(
  relation: DocumentProjectionRelation,
  sourcePath: string
) {
  const normalizedSourcePath = documentSourcePagePath(sourcePath);
  const sourceIsFrom = documentSourcePagePath(relation.fromPath) === normalizedSourcePath;
  const sourceIsTo = documentSourcePagePath(relation.toPath) === normalizedSourcePath;
  if (!sourceIsFrom && !sourceIsTo) throw recordError("relation_endpoint_missing");
  return {
    targetPath: documentSourcePagePath(sourceIsFrom ? relation.toPath : relation.fromPath),
    targetTitle: sourceIsFrom ? relation.toTitle : relation.fromTitle,
    direction: sourceIsFrom ? "outgoing" : "incoming",
    relationType: relation.relationType,
    weight: 1,
    reason: relationReason(relation),
    evidence: portableEvidence(relation)
  };
}

function relationReason(relation: DocumentProjectionRelation): string {
  const reason = relation.evidenceValue.reason;
  if (typeof reason === "string" && reason.trim()) return reason.trim().slice(0, 1_024);
  if (relation.evidenceKind === "markdown_link") {
    return `${relation.fromTitle} contains an explicit Markdown reference to ${relation.toTitle}.`;
  }
  if (relation.evidenceKind === "okf_metadata") {
    return `${relation.fromTitle} metadata explicitly references ${relation.toTitle}.`;
  }
  if (relation.evidenceKind === "stable_alias") {
    return `${relation.fromTitle} contains a unique stable reference to ${relation.toTitle}.`;
  }
  return `${relation.fromTitle} contains source-grounded evidence relating it to ${relation.toTitle}.`;
}

function portableEvidence(relation: DocumentProjectionRelation): PortableEvidence[] {
  const value = relation.evidenceValue;
  const excerpt = [value.sourceExcerpt, value.excerpt]
    .find((item): item is string => typeof item === "string" && item.trim().length > 0);
  const heading = typeof value.heading === "string" && value.heading.trim()
    ? value.heading.trim().slice(0, 256) : undefined;
  return [{
    path: documentSourcePagePath(relation.fromPath),
    ...(heading ? { heading } : {}),
    ...(excerpt ? { excerpt: excerpt.trim().slice(0, 1_024) } : {})
  }];
}

function metadataString(source: DocumentProjectionSource, key: string): string | null {
  const value = source.metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function metadataStrings(source: DocumentProjectionSource, key: string): string[] {
  return metadataValues(source.metadata, [key]);
}

function metadataValues(
  metadata: Readonly<Record<string, unknown>>,
  keys: readonly string[]
): string[] {
  const result: string[] = [];
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) result.push(value.trim());
    if (Array.isArray(value)) {
      result.push(...value.filter((item): item is string =>
        typeof item === "string" && item.trim().length > 0).map((item) => item.trim()));
    }
  }
  return [...new Set(result)].sort(compareText).slice(0, 256);
}

function headings(body: string): string[] {
  return body.split("\n").flatMap((line) => {
    const value = line.match(/^#{1,6}\s+(.+)$/u)?.[1]?.trim();
    return value ? [value] : [];
  }).slice(0, 128);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function recordError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document machine record error: ${code}`), { code });
}
