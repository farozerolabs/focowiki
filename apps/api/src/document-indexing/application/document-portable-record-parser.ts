import {
  assertPortableRecord,
  portableSemanticResourceFamilyForPath,
  type PortableRecordFamily
} from "@focowiki/okf";
import {
  arrayRecords,
  type ProjectionRecord
} from "./document-machine-projection-shared.js";

export function parseDocumentPortableRecords(
  bytes: Uint8Array,
  logicalPath: string
): readonly ProjectionRecord[] {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > 268_435_456) {
    throw portableRecordError("existing_resource_invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw portableRecordError("existing_resource_invalid");
  }
  const family = familyForPortablePath(logicalPath);
  if (!family) throw portableRecordError("existing_resource_path_invalid");
  try {
    assertPortableRecord(family, value);
  } catch {
    throw portableRecordError("existing_resource_invalid");
  }
  const record = value as ProjectionRecord;
  if (family === "document_packet") return arrayRecords(record.documents);
  if (family === "term_postings") return arrayRecords(record.terms);
  if (family === "relationship_packet") {
    return arrayRecords(record.relationships);
  }
  return [record];
}

function familyForPortablePath(path: string): PortableRecordFamily | null {
  if (path === "_index/catalog.json") return "index_catalog";
  if (path === "_graph/catalog.json") return "graph_catalog";
  if (path === "_index/terms/index.json") return "term_catalog";
  if (/^_index\/terms\/(?:latin|han|kana|hangul|number|other)\/index\.json$/u
    .test(path)) return "term_bucket";
  if (/^_index\/pages(?:\/[^/]+)*\/index\.json$/u.test(path)) {
    return "page_directory";
  }
  const semanticFamily = portableSemanticResourceFamilyForPath(path);
  if (semanticFamily === "documents") return "document_packet";
  if (semanticFamily === "terms") return "term_postings";
  if (/^_graph\/by-directory(?:\/[^/]+)*\/index\.json$/u.test(path)) {
    return "graph_directory";
  }
  if (semanticFamily === "relationships") return "relationship_packet";
  if (/^_graph\/by-file\/.+\.json$/u.test(path)) return "per_file_graph";
  return null;
}

function portableRecordError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Portable record error: ${code}`), { code });
}
