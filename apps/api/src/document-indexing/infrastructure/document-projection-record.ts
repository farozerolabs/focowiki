import { portableByFileGraphPath } from "@focowiki/okf";

export function mapDocumentProjectionRecord(row: {
  page_path: string;
  title: string;
  summary: string;
  metadata: Record<string, unknown>;
  headings: string[];
  entities: string[];
  content_type: string;
  checksum_sha256: string;
  byte_count: number | string;
  relationship_count: number | string;
}): Record<string, unknown> {
  const path = row.page_path;
  return {
    path,
    title: row.title,
    summary: row.summary,
    type: metadataString(row.metadata, "type") ?? "document",
    ...(metadataString(row.metadata, "description")
      ? { description: metadataString(row.metadata, "description") } : {}),
    subjects: metadataStrings(row.metadata, "subjects"),
    tags: metadataStrings(row.metadata, "tags"),
    metadata: row.metadata,
    headings: row.headings,
    keywords: metadataStrings(row.metadata, "keywords"),
    ...(metadataString(row.metadata, "language")
      ? { language: metadataString(row.metadata, "language") } : {}),
    entities: row.entities,
    contentType: row.content_type,
    checksumSha256: row.checksum_sha256,
    byteCount: Number(row.byte_count),
    relationshipCount: Number(row.relationship_count),
    ...(Number(row.relationship_count) > 0
      ? { graphPath: portableByFileGraphPath(path) } : {})
  };
}

function metadataString(
  metadata: Readonly<Record<string, unknown>>,
  key: string
): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function metadataStrings(
  metadata: Readonly<Record<string, unknown>>,
  key: string
): string[] {
  const value = metadata[key];
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return Array.isArray(value) ? value.filter((item): item is string =>
    typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim()) : [];
}
