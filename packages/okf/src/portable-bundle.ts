import { posix } from "node:path";

export type PortableRecordFamily =
  | "index_catalog"
  | "page_directory"
  | "document_packet"
  | "term_catalog"
  | "term_bucket"
  | "term_postings"
  | "graph_catalog"
  | "graph_directory"
  | "relationship_packet"
  | "per_file_graph"
  | "navigation"
  | "source_fragment"
  | "history";

export type PortablePageRef = Readonly<{ path: string; title: string }>;
export type PortableEvidence = Readonly<{
  path: string;
  heading?: string;
  excerpt?: string;
  reason?: string;
}>;
export type PortableRelationship = Readonly<{
  from: string;
  to: string;
  fromTitle: string;
  toTitle: string;
  relationType: string;
  weight?: number;
  reason: string;
  evidence: readonly PortableEvidence[];
}>;

export function comparePortableRecordKeys(left: string, right: string): number {
  let leftOffset = 0;
  let rightOffset = 0;
  while (leftOffset < left.length && rightOffset < right.length) {
    const leftCodePoint = left.codePointAt(leftOffset)!;
    const rightCodePoint = right.codePointAt(rightOffset)!;
    if (leftCodePoint !== rightCodePoint) {
      return leftCodePoint < rightCodePoint ? -1 : 1;
    }
    leftOffset += leftCodePoint > 0xffff ? 2 : 1;
    rightOffset += rightCodePoint > 0xffff ? 2 : 1;
  }
  if (leftOffset === left.length && rightOffset === right.length) return 0;
  return leftOffset === left.length ? -1 : 1;
}

const RESERVED_PAGE_SEGMENTS = new Set(["_graph", "_index", "_segments"]);
export const PORTABLE_LOGICAL_SEGMENT_MAX_CODE_POINTS = 1_000;
export type PortableSemanticResourceFamily =
  | "documents"
  | "relationships"
  | "terms";
const FORBIDDEN_GENERATED_TEXT = [
  /\bfocowiki\b/iu,
  /process:focowiki/iu,
  /\bmodel[_ -]?(?:confirmed|generated|execution)\b/iu,
  /\b(?:publication|projection|provider|worker|storage)[_ -]?(?:state|phase|profile|identity|activated|processing)?\b/iu,
  /\b(?:knowledge-base|source-file|source-revision|file-relation|document-job|object)-[a-z0-9-]+\b/iu,
  /https?:\/\//iu,
  /\/openapi\/v\d+\//iu
] as const;
const INTERNAL_IDENTIFIER_VALUE = /^(?:knowledge-base|source-file|source-revision|file-relation|document-job|object|operation|work)-[a-z0-9-]+$/iu;
const EVIDENCE_KEYS = new Set(["path", "heading", "excerpt", "reason"]);
const RELATIONSHIP_KEYS = new Set([
  "from", "to", "fromTitle", "toTitle", "direction", "relationType", "weight",
  "reason", "evidence"
]);
const LOCAL_RELATIONSHIP_KEYS = new Set([
  "targetPath", "targetTitle", "direction", "relationType", "weight", "reason",
  "evidence"
]);
const RESOURCE_KEYS = new Set(["kind", "title", "path", "description"]);
const CHILD_DIRECTORY_KEYS = new Set(["title", "scopePath", "path"]);
const PART_KEYS = new Set(["path", "recordCount", "firstKey", "lastKey", "byteCount"]);
const DOCUMENT_KEYS = new Set([
  "path", "title", "summary", "type", "description", "resource", "timestamp",
  "subjects", "tags", "metadata", "headings", "keywords", "language", "entities",
  "contentType", "checksumSha256", "byteCount", "relationshipCount", "graphPath"
]);
const TERM_BUCKET_KEYS = new Set(["bucket", "path"]);
const TERM_ROUTE_KEYS = new Set([
  "path", "firstTerm", "lastTerm", "recordCount"
]);
const TERM_ENTRY_KEYS = new Set(["term", "postings"]);
const POSTING_KEYS = new Set(["path", "fields"]);
const TERM_BUCKET_NAMES = new Set([
  "latin", "han", "kana", "hangul", "number", "other"
]);

export function normalizePortablePagePath(input: string): string {
  if (typeof input !== "string" || input.length === 0 || input.length > 2_048
    || /^[a-z]:[\\/]/iu.test(input) || input.startsWith("/")
    || /[\0\r\n]/u.test(input)) {
    throw portableBundleError("portable_page_path_invalid");
  }
  const normalizedInput = input.replace(/\\/gu, "/").normalize("NFC");
  const withRoot = normalizedInput.startsWith("pages/")
    ? normalizedInput : `pages/${normalizedInput}`;
  const segments = withRoot.split("/");
  if (segments.length < 2 || segments.some((segment) =>
    !segment || segment === "." || segment === ".."
    || [...segment].length > PORTABLE_LOGICAL_SEGMENT_MAX_CODE_POINTS)) {
    throw portableBundleError("portable_page_path_invalid");
  }
  if (RESERVED_PAGE_SEGMENTS.has(segments[1]!.toLocaleLowerCase("en-US"))) {
    throw portableBundleError("portable_page_path_reserved");
  }
  if (!withRoot.toLocaleLowerCase("en-US").endsWith(".md")) {
    throw portableBundleError("portable_page_path_invalid");
  }
  return withRoot;
}

export function normalizePortableDirectoryPath(input: string): string {
  if (input === "pages") return input;
  if (typeof input !== "string" || !input.startsWith("pages/")
    || input.endsWith("/") || input.endsWith(".md")) {
    throw portableBundleError("portable_directory_path_invalid");
  }
  try {
    return posix.dirname(normalizePortablePagePath(`${input}/placeholder.md`));
  } catch {
    throw portableBundleError("portable_directory_path_invalid");
  }
}

export function assertPortablePathSet(paths: readonly string[]): void {
  const normalized = new Map<string, string>();
  for (const input of paths) {
    const path = normalizePortablePagePath(input);
    const key = path.normalize("NFC").toLocaleLowerCase("en-US");
    if (normalized.has(key)) throw portableBundleError("portable_page_path_collision");
    normalized.set(key, path);
  }
}

export function portableByFileGraphPath(pagePath: string): string {
  const path = normalizePortablePagePath(pagePath);
  return `_graph/by-file/${path.slice("pages/".length, -".md".length)}.json`;
}

export function portableByFileGraphDirectoryPath(
  pageDirectoryPath: string
): string {
  const path = normalizePortableDirectoryPath(pageDirectoryPath);
  return `_graph/by-file${path === "pages" ? "" : path.slice("pages".length)}`;
}

export function portableIndexDirectoryPath(pageDirectoryPath: string): string {
  const path = normalizePortableDirectoryPath(pageDirectoryPath);
  return `_index/pages${path === "pages" ? "" : path.slice("pages".length)}`;
}

export function portableGraphDirectoryPath(pageDirectoryPath: string): string {
  const path = normalizePortableDirectoryPath(pageDirectoryPath);
  return `_graph/by-directory${path === "pages" ? "" : path.slice("pages".length)}`;
}

export function portableSemanticResourceFileName(input: Readonly<{
  subject: string;
  family: PortableSemanticResourceFamily;
  partNumber?: number;
}>): string {
  const subject = normalizePortableSemanticSubject(input.subject);
  if (input.partNumber !== undefined
    && (!Number.isSafeInteger(input.partNumber)
      || input.partNumber < 1 || input.partNumber > 9_999)) {
    throw portableBundleError("portable_semantic_part_invalid");
  }
  const suffix = `-${input.family}${input.partNumber === undefined ? ""
    : `-part-${String(input.partNumber).padStart(4, "0")}`}.json`;
  const suffixCodePoints = [...suffix];
  const subjectCodePoints = [...subject];
  if (subjectCodePoints.length + suffixCodePoints.length
    <= PORTABLE_LOGICAL_SEGMENT_MAX_CODE_POINTS) {
    return `${subject}${suffix}`;
  }
  const availableSubjectCodePoints = PORTABLE_LOGICAL_SEGMENT_MAX_CODE_POINTS
    - suffixCodePoints.length - 1;
  if (availableSubjectCodePoints < 1) {
    throw portableBundleError("portable_semantic_filename_invalid");
  }
  return `${subjectCodePoints.slice(0, availableSubjectCodePoints).join("")}…${suffix}`;
}

export function portableDirectoryResourceSubject(pageDirectoryPath: string): string {
  const path = normalizePortableDirectoryPath(pageDirectoryPath);
  return path === "pages" ? "all" : posix.basename(path);
}

export function portableSemanticResourceFamilyForPath(
  path: string
): PortableSemanticResourceFamily | null {
  const pageMatch = /^_index\/pages((?:\/[^/]+)*)\/([^/]+\.json)$/u.exec(path);
  if (pageMatch) {
    const scopePath = `pages${pageMatch[1]}`;
    return matchesPortableSemanticResourceFileName({
      fileName: pageMatch[2]!,
      subject: portableDirectoryResourceSubject(scopePath),
      family: "documents"
    }) ? "documents" : null;
  }
  const termMatch = /^_index\/terms\/(latin|han|kana|hangul|number|other)\/\1-terms-part-\d{4}\.json$/u.exec(path);
  if (termMatch) {
    return "terms";
  }
  const graphMatch = /^_graph\/by-directory((?:\/[^/]+)*)\/([^/]+\.json)$/u
    .exec(path);
  if (graphMatch) {
    const scopePath = `pages${graphMatch[1]}`;
    return matchesPortableSemanticResourceFileName({
      fileName: graphMatch[2]!,
      subject: portableDirectoryResourceSubject(scopePath),
      family: "relationships"
    }) ? "relationships" : null;
  }
  return null;
}

function matchesPortableSemanticResourceFileName(input: Readonly<{
  fileName: string;
  subject: string;
  family: PortableSemanticResourceFamily;
}>): boolean {
  if (input.fileName === portableSemanticResourceFileName(input)) return true;
  const partMatch = /-part-(\d{4})\.json$/u.exec(input.fileName);
  if (!partMatch) return false;
  const partNumber = Number.parseInt(partMatch[1]!, 10);
  return input.fileName === portableSemanticResourceFileName({
    subject: input.subject, family: input.family, partNumber
  });
}

export function normalizePortableTerm(value: string): string {
  const term = portableTermOrNull(value);
  if (term === null) throw portableBundleError("portable_term_invalid");
  return term;
}

export function portableTermOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const term = value.normalize("NFKC").toLocaleLowerCase("und")
    .replace(/\s+/gu, " ").trim();
  if (!term || Buffer.byteLength(term, "utf8") > 512 || /[\0\r\n/\\]/u.test(term)) {
    return null;
  }
  return term;
}

export function portableDisplayTitleFromPagePath(pagePath: string): string {
  const path = normalizePortablePagePath(pagePath);
  const title = posix.basename(path, ".md").trim();
  if (!title || title === ".md") throw portableBundleError("portable_page_title_invalid");
  return title;
}

export function pagePathFromPortableByFileGraphPath(graphPath: string): string {
  if (typeof graphPath !== "string" || !graphPath.startsWith("_graph/by-file/")
    || !graphPath.endsWith(".json") || graphPath.includes("\\")
    || graphPath.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw portableBundleError("portable_graph_path_invalid");
  }
  return normalizePortablePagePath(
    `${graphPath.slice("_graph/by-file/".length, -".json".length)}.md`
  );
}

export function portableMarkdownHref(fromPath: string, targetPath: string): string {
  const from = normalizePortableBundlePath(fromPath);
  const target = normalizePortableBundlePath(targetPath);
  const relative = posix.relative(posix.dirname(from), target) || posix.basename(target);
  return relative.split("/").map((segment) =>
    segment === ".." || segment === "." ? segment : encodePathSegment(segment)
  ).join("/");
}

export function assertPortableRecord(family: PortableRecordFamily, value: unknown): void {
  const record = objectRecord(value, "portable_record_invalid");
  switch (family) {
    case "index_catalog":
    case "graph_catalog": validateCatalog(record); return;
    case "page_directory": validateDirectoryRouter(record, "documentCount"); return;
    case "graph_directory": validateDirectoryRouter(record, "relationshipCount"); return;
    case "document_packet": validateDocumentPacket(record); return;
    case "term_catalog": validateTermCatalog(record); return;
    case "term_bucket": validateTermBucket(record); return;
    case "term_postings": validateTermPostings(record); return;
    case "relationship_packet": validateRelationshipPacket(record); return;
    case "per_file_graph": validatePerFileGraph(record); return;
    case "navigation":
      assertExactKeys(record, new Set(["type", "title"]));
      requireStrings(record, ["type", "title"]);
      validatePortableGeneratedText(asString(record.type));
      validatePortableGeneratedText(asString(record.title));
      return;
    case "source_fragment":
      assertExactKeys(record, new Set(["path", "title", "concepts", "relationships"]));
      requireStrings(record, ["path", "title"]);
      normalizePortablePagePath(asString(record.path));
      if (!Array.isArray(record.concepts) || !Array.isArray(record.relationships)) {
        throw portableBundleError("portable_record_invalid");
      }
      return;
    case "history":
      assertExactKeys(record, new Set(["action", "path", "previousPath", "title", "occurredAt"]));
      requireStrings(record, ["action", "path", "title", "occurredAt"]);
      if (!new Set(["added", "updated", "moved", "removed"]).has(asString(record.action))) {
        throw portableBundleError("portable_record_invalid");
      }
      normalizePortablePagePath(asString(record.path));
      if (record.previousPath !== undefined) normalizePortablePagePath(asString(record.previousPath));
      return;
    default: throw portableBundleError("portable_record_family_invalid");
  }
}

function validateCatalog(record: Record<string, unknown>): void {
  assertExactKeys(record, new Set([
    "formatVersion", "title", "resources", "relationshipCount"
  ]));
  assertFormatVersion(record);
  requireStrings(record, ["title"]);
  validatePortableGeneratedText(asString(record.title));
  if (record.relationshipCount !== undefined) {
    validateNonNegativeInteger(record.relationshipCount);
  }
  if (!Array.isArray(record.resources) || record.resources.length > 4_096) {
    throw portableBundleError("portable_record_invalid");
  }
  for (const value of record.resources) {
    const resource = objectRecord(value, "portable_record_invalid");
    assertExactKeys(resource, RESOURCE_KEYS);
    requireStrings(resource, ["kind", "title", "path", "description"]);
    normalizePortableBundlePath(asString(resource.path));
    validatePortableGeneratedText(asString(resource.title));
    validatePortableGeneratedText(asString(resource.description));
  }
  assertUnique(record.resources.map((value) =>
    asString((value as Record<string, unknown>).path)));
}

function validateDirectoryRouter(record: Record<string, unknown>, countKey: "documentCount" | "relationshipCount"): void {
  assertExactKeys(record, new Set([
    "formatVersion", "title", "scopePath", "parentPath", "childDirectories",
    "resources", countKey
  ]));
  assertFormatVersion(record);
  requireStrings(record, ["title", "scopePath"]);
  normalizePortableDirectoryPath(asString(record.scopePath));
  if (record.parentPath !== undefined) normalizePortableBundlePath(asString(record.parentPath));
  validateNonNegativeInteger(record[countKey]);
  if (!Array.isArray(record.childDirectories) || record.childDirectories.length > 100_000
    || !Array.isArray(record.resources) || record.resources.length > 100_000) {
    throw portableBundleError("portable_record_invalid");
  }
  for (const value of record.childDirectories) {
    const child = objectRecord(value, "portable_record_invalid");
    assertExactKeys(child, CHILD_DIRECTORY_KEYS);
    requireStrings(child, ["title", "scopePath", "path"]);
    normalizePortableDirectoryPath(asString(child.scopePath));
    normalizePortableBundlePath(asString(child.path));
  }
  for (const value of record.resources) {
    validatePartDescriptor(value);
    const resourcePath = asString((value as Record<string, unknown>).path);
    const expectedFamily = countKey === "documentCount"
      ? "documents" : "relationships";
    if (portableSemanticResourceFamilyForPath(resourcePath) !== expectedFamily) {
      throw portableBundleError("portable_record_invalid");
    }
    const expectedDirectory = countKey === "documentCount"
      ? portableIndexDirectoryPath(asString(record.scopePath))
      : portableGraphDirectoryPath(asString(record.scopePath));
    if (posix.dirname(resourcePath) !== expectedDirectory) {
      throw portableBundleError("portable_record_invalid");
    }
  }
  assertUnique(record.childDirectories.map((value) =>
    asString((value as Record<string, unknown>).scopePath)));
  assertUnique(record.resources.map((value) =>
    asString((value as Record<string, unknown>).path)));
}

function validateDocumentPacket(record: Record<string, unknown>): void {
  assertExactKeys(record, new Set(["formatVersion", "title", "scopePath", "documents"]));
  assertFormatVersion(record);
  requireStrings(record, ["title", "scopePath"]);
  const scopePath = normalizePortableDirectoryPath(asString(record.scopePath));
  if (!Array.isArray(record.documents) || record.documents.length > 100_000) {
    throw portableBundleError("portable_record_invalid");
  }
  for (const value of record.documents) {
    const document = objectRecord(value, "portable_record_invalid");
    assertExactKeys(document, DOCUMENT_KEYS);
    requireStrings(document, ["path", "title", "summary", "contentType", "checksumSha256"]);
    const path = normalizePortablePagePath(asString(document.path));
    const relationshipCount = document.relationshipCount;
    validateNonNegativeInteger(relationshipCount);
    if (posix.dirname(path) !== scopePath
      || (document.graphPath !== undefined
        && portableByFileGraphPath(path) !== asString(document.graphPath))
      || (relationshipCount === 0 && document.graphPath !== undefined)
      || (typeof relationshipCount === "number" && relationshipCount > 0
        && document.graphPath === undefined)
      || !/^[0-9a-f]{64}$/u.test(asString(document.checksumSha256))) {
      throw portableBundleError("portable_record_invalid");
    }
    validateNonNegativeInteger(document.byteCount);
    for (const key of ["tags", "subjects", "headings", "keywords", "entities"] as const) {
      validateStringArray(document[key]);
    }
    if (!objectOrUndefined(document.metadata)) throw portableBundleError("portable_record_invalid");
  }
  assertUniqueOrdered(record.documents.map((value) =>
    asString((value as Record<string, unknown>).path)), "documents.path");
}

function validateTermCatalog(record: Record<string, unknown>): void {
  assertExactKeys(record, new Set([
    "formatVersion", "title", "normalization", "buckets"
  ]));
  assertFormatVersion(record);
  requireStrings(record, ["title"]);
  const normalization = objectRecord(record.normalization, "portable_record_invalid");
  assertExactKeys(normalization, new Set(["unicodeNormalization", "caseFolding", "tokenization"]));
  if (normalization.unicodeNormalization !== "NFKC" || normalization.caseFolding !== "unicode"
    || normalization.tokenization !== "nodejieba-search-v1"
    || !Array.isArray(record.buckets) || record.buckets.length > 6) {
    throw portableBundleError("portable_record_invalid");
  }
  for (const value of record.buckets) {
    const bucket = objectRecord(value, "portable_record_invalid");
    assertExactKeys(bucket, TERM_BUCKET_KEYS);
    requireStrings(bucket, ["bucket", "path"]);
    const name = asString(bucket.bucket);
    if (!TERM_BUCKET_NAMES.has(name)
      || asString(bucket.path) !== `_index/terms/${name}/index.json`) {
      throw portableBundleError("portable_record_invalid");
    }
  }
  assertUniqueOrdered(record.buckets.map((value) =>
    asString((value as Record<string, unknown>).bucket)), "buckets.bucket");
}

function validateTermBucket(record: Record<string, unknown>): void {
  assertExactKeys(record, new Set([
    "formatVersion", "title", "bucket", "routes"
  ]));
  assertFormatVersion(record);
  requireStrings(record, ["title", "bucket"]);
  const bucket = asString(record.bucket);
  if (!TERM_BUCKET_NAMES.has(bucket)
    || !Array.isArray(record.routes) || record.routes.length > 100_000) {
    throw portableBundleError("portable_record_invalid");
  }
  for (const value of record.routes) {
    const route = objectRecord(value, "portable_record_invalid");
    assertExactKeys(route, TERM_ROUTE_KEYS);
    requireStrings(route, ["path"]);
    normalizePortableBundlePath(asString(route.path));
    if (portableSemanticResourceFamilyForPath(asString(route.path)) !== "terms"
      || posix.dirname(asString(route.path)) !== `_index/terms/${bucket}`) {
      throw portableBundleError("portable_record_invalid");
    }
    const firstTerm = validatedPortableTerm(route.firstTerm);
    const lastTerm = validatedPortableTerm(route.lastTerm);
    if (comparePortableRecordKeys(firstTerm, lastTerm) > 0) {
      throw portableBundleError("portable_record_invalid");
    }
    validateNonNegativeInteger(route.recordCount);
  }
  const routes = record.routes as Record<string, unknown>[];
  assertUniqueField(routes.map((route) => asString(route.path)),
    "routes.path");
  assertOrdered(routes.map((route) => validatedPortableTerm(route.firstTerm)),
    "routes.firstTerm");
  for (let index = 1; index < routes.length; index += 1) {
    const previousLast = validatedPortableTerm(routes[index - 1]!.lastTerm);
    const currentFirst = validatedPortableTerm(routes[index]!.firstTerm);
    if (comparePortableRecordKeys(previousLast, currentFirst) > 0) {
      throw Object.assign(
        portableBundleError("portable_record_order_invalid"),
        { recordField: "routes.range" }
      );
    }
  }
}

function validateTermPostings(record: Record<string, unknown>): void {
  assertExactKeys(record, new Set(["formatVersion", "title", "bucket", "terms"]));
  assertFormatVersion(record);
  requireStrings(record, ["title", "bucket"]);
  if (!new Set(["latin", "han", "kana", "hangul", "number", "other"])
    .has(asString(record.bucket))) {
    throw portableBundleError("portable_record_invalid");
  }
  if (!Array.isArray(record.terms) || record.terms.length > 100_000) {
    throw portableBundleError("portable_record_invalid");
  }
  for (const value of record.terms) {
    const entry = objectRecord(value, "portable_record_invalid");
    assertExactKeys(entry, TERM_ENTRY_KEYS);
    validatedPortableTerm(entry.term);
    if (!Array.isArray(entry.postings) || entry.postings.length > 100_000) {
      throw portableBundleError("portable_record_invalid");
    }
    for (const postingValue of entry.postings) {
      const posting = objectRecord(postingValue, "portable_record_invalid");
      assertExactKeys(posting, POSTING_KEYS);
      requireStrings(posting, ["path"]);
      normalizePortablePagePath(asString(posting.path));
      validateStringArray(posting.fields);
    }
    assertUniqueOrdered(entry.postings.map((posting) =>
      asString((posting as Record<string, unknown>).path)),
    "terms.postings.path");
  }
  assertUniqueOrdered(record.terms.map((value) =>
    validatedPortableTerm((value as Record<string, unknown>).term)),
  "terms.term");
}

function validatedPortableTerm(value: unknown): string {
  if (typeof value !== "string") {
    throw portableBundleError("portable_record_invalid");
  }
  const normalized = normalizePortableTerm(value);
  if (normalized !== value) {
    throw portableBundleError("portable_record_invalid");
  }
  return value;
}

function validateRelationshipPacket(record: Record<string, unknown>): void {
  assertExactKeys(record, new Set(["formatVersion", "title", "scopePath", "relationships"]));
  assertFormatVersion(record);
  requireStrings(record, ["title", "scopePath"]);
  const scope = normalizePortableDirectoryPath(asString(record.scopePath));
  if (!Array.isArray(record.relationships) || record.relationships.length > 100_000) {
    throw portableBundleError("portable_record_invalid");
  }
  for (const value of record.relationships) {
    const relationship = validateRelationship(value, false);
    if (posix.dirname(asString(relationship.from)) !== scope) {
      throw portableBundleError("portable_record_invalid");
    }
  }
  assertUniqueOrdered(record.relationships.map(relationshipIdentity),
    "relationships.identity");
}

function validatePerFileGraph(record: Record<string, unknown>): void {
  assertExactKeys(record, new Set([
    "formatVersion", "title", "path", "indexPath", "directoryGraphPath", "relationships"
  ]));
  assertFormatVersion(record);
  requireStrings(record, ["title", "path", "indexPath", "directoryGraphPath"]);
  const path = normalizePortablePagePath(asString(record.path));
  normalizePortableBundlePath(asString(record.indexPath));
  normalizePortableBundlePath(asString(record.directoryGraphPath));
  if (!Array.isArray(record.relationships) || record.relationships.length > 10_000) {
    throw portableBundleError("portable_record_invalid");
  }
  for (const value of record.relationships) validateRelationship(value, true, [asString(record.title)]);
  assertUniqueOrdered(record.relationships.map((value) => {
    const relationship = value as Record<string, unknown>;
    return [relationship.targetPath, relationship.relationType, relationship.direction]
      .map(asString).join("\0");
  }), "relationships.identity");
  if (`${portableIndexDirectoryPath(posix.dirname(path))}/index.json` !== record.indexPath
    || `${portableGraphDirectoryPath(posix.dirname(path))}/index.json` !== record.directoryGraphPath) {
    throw portableBundleError("portable_record_invalid");
  }
}

function validateRelationship(value: unknown, local: boolean, userText: readonly string[] = []): Record<string, unknown> {
  const relationship = objectRecord(value, "portable_record_invalid");
  assertExactKeys(relationship, local ? LOCAL_RELATIONSHIP_KEYS : RELATIONSHIP_KEYS);
  const pathKeys = local ? ["targetPath"] : ["from", "to"];
  const titleKeys = local ? ["targetTitle"] : ["fromTitle", "toTitle"];
  requireStrings(relationship, [...pathKeys, ...titleKeys, "direction", "relationType", "reason"]);
  for (const key of pathKeys) normalizePortablePagePath(asString(relationship[key]));
  if (!new Set(["incoming", "outgoing", "bidirectional"]).has(asString(relationship.direction))) {
    throw portableBundleError("portable_record_invalid");
  }
  validatePortableWeight(relationship.weight);
  const titles = [...titleKeys.map((key) => asString(relationship[key])), ...userText];
  validatePortableGeneratedText(asString(relationship.reason), { userText: titles });
  validateEvidence(relationship.evidence, titles);
  return relationship;
}

function validatePartDescriptor(value: unknown): void {
  const part = objectRecord(value, "portable_record_invalid");
  assertExactKeys(part, PART_KEYS);
  requireStrings(part, ["path", "firstKey", "lastKey"]);
  const path = normalizePortableBundlePath(asString(part.path));
  if (!path.endsWith(".json") || /\/(?:v\d+\/)?\d{4}\.json$/u.test(path)) {
    throw portableBundleError("portable_record_invalid");
  }
  validateNonNegativeInteger(part.recordCount);
  validateNonNegativeInteger(part.byteCount);
}

function assertFormatVersion(record: Record<string, unknown>): void {
  if (record.formatVersion !== 2) throw portableBundleError("portable_record_invalid");
}

function validatePortableWeight(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw portableBundleError("portable_record_invalid");
  }
}

export function validatePortableGeneratedText(value: string, options: Readonly<{
  ownership?: "generated" | "user";
  userText?: readonly string[];
}> = {}): void {
  if (options.ownership === "user") return;
  const generatedOnly = [...(options.userText ?? [])]
    .filter((item) => typeof item === "string" && item.length > 0)
    .sort((left, right) => right.length - left.length)
    .reduce((result, userText) => result.replaceAll(userText, "[user text]"), value);
  if (typeof value !== "string" || value.length > 16_384
    || FORBIDDEN_GENERATED_TEXT.some((pattern) => pattern.test(generatedOnly))) {
    throw portableBundleError("portable_generated_text_forbidden");
  }
}

export function validatePortablePathClosure(input: Readonly<{
  readablePages: readonly string[];
  indexPaths: readonly string[];
  graphPaths: readonly string[];
  relations: readonly Readonly<{ from: string; to: string; relationType: string }>[];
}>): void {
  assertPortablePathSet(input.readablePages);
  const readable = new Set(input.readablePages.map(normalizePortablePagePath));
  for (const path of input.indexPaths) {
    if (!readable.has(normalizePortablePagePath(path))) {
      throw portableBundleError("portable_closure_orphan_index");
    }
  }
  const graphSources = new Set<string>();
  for (const path of input.graphPaths) {
    const source = pagePathFromPortableByFileGraphPath(path);
    if (!readable.has(source)) throw portableBundleError("portable_closure_orphan_graph");
    graphSources.add(source);
  }
  for (const source of readable) {
    if (!graphSources.has(source)) throw portableBundleError("portable_closure_missing_graph");
  }
  for (const relation of input.relations) {
    const from = normalizePortablePagePath(relation.from);
    const to = normalizePortablePagePath(relation.to);
    if (!readable.has(from) || !readable.has(to) || !relation.relationType.trim()) {
      throw portableBundleError("portable_closure_orphan_relation");
    }
  }
}

export function normalizePortableBundlePath(path: string): string {
  if (typeof path !== "string" || path.length === 0 || path.length > 2_048
    || path.startsWith("/") || path.includes("\\") || /[\0\r\n]/u.test(path)) {
    throw portableBundleError("portable_bundle_path_invalid");
  }
  const normalized = path.normalize("NFC");
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw portableBundleError("portable_bundle_path_invalid");
  }
  return normalized;
}

function validateEvidence(value: unknown, userText: readonly string[] = []): void {
  if (!Array.isArray(value)) throw portableBundleError("portable_record_invalid");
  for (const evidence of value) {
    const item = objectRecord(evidence, "portable_record_invalid");
    assertExactKeys(item, EVIDENCE_KEYS);
    normalizePortablePagePath(asString(item.path));
    if (item.reason !== undefined) validatePortableGeneratedText(asString(item.reason), { userText });
  }
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function normalizePortableSemanticSubject(value: string): string {
  if (typeof value !== "string") {
    throw portableBundleError("portable_semantic_subject_invalid");
  }
  const normalized = value.normalize("NFC");
  if (!normalized || /[\0\r\n/\\]/u.test(normalized)) {
    throw portableBundleError("portable_semantic_subject_invalid");
  }
  return normalized;
}

function objectRecord(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw portableBundleError(code);
  }
  return value as Record<string, unknown>;
}

function objectOrUndefined(value: unknown): boolean {
  return value === undefined || typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Readonly<Record<string, unknown>>, allowed: ReadonlySet<string>): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw portableBundleError("portable_record_unknown_key");
  }
}

function relationshipIdentity(value: unknown): string {
  const relationship = value as Record<string, unknown>;
  return [relationship.from, relationship.to, relationship.relationType]
    .map(asString).join("\0");
}

function assertUnique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) {
    throw portableBundleError("portable_record_duplicate");
  }
}

function assertUniqueOrdered(
  values: readonly string[],
  recordField: string
): void {
  assertUniqueField(values, recordField);
  assertOrdered(values, recordField);
}

function assertUniqueField(
  values: readonly string[],
  recordField: string
): void {
  if (new Set(values).size !== values.length) {
    throw Object.assign(
      portableBundleError("portable_record_duplicate"),
      { recordField }
    );
  }
}

function assertOrdered(
  values: readonly string[],
  recordField: string
): void {
  for (let index = 1; index < values.length; index += 1) {
    if (comparePortableRecordKeys(values[index - 1]!, values[index]!) > 0) {
      throw Object.assign(
        portableBundleError("portable_record_order_invalid"),
        { recordField }
      );
    }
  }
}

function requireStrings(record: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) asString(record[key]);
}

function validateStringArray(value: unknown): void {
  if (!Array.isArray(value) || value.length > 100_000
    || value.some((item) => typeof item !== "string" || !item)) {
    throw portableBundleError("portable_record_invalid");
  }
}

function validateNonNegativeInteger(value: unknown): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw portableBundleError("portable_record_invalid");
  }
}

function asString(value: unknown): string {
  if (typeof value !== "string" || !value || INTERNAL_IDENTIFIER_VALUE.test(value)) {
    throw portableBundleError("portable_record_invalid");
  }
  return value;
}

function portableBundleError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Portable bundle error: ${code}`), { code });
}
