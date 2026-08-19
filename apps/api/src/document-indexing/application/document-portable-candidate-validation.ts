import {
  normalizePortablePagePath,
  pagePathFromPortableByFileGraphPath,
  portableByFileGraphPath,
  portableSemanticResourceFamilyForPath
} from "@focowiki/okf";
import { parseDocumentPortableRecords } from
  "./document-portable-record-parser.js";

type CandidatePage = Readonly<{
  logicalPath: string;
  bytes: Uint8Array;
  checksumSha256: string;
  byteCount: number;
}>;

export function collectDocumentPortableReferencedPagePaths(
  pages: readonly CandidatePage[]
): string[] {
  return [...new Set(pages.flatMap((page) => {
    if (!page.logicalPath.endsWith(".json")) return [];
    const value = parseJson(page);
    return [
      ...portableRecords(page).flatMap(recordPagePaths),
      ...recordResourcePaths(value)
    ];
  }))].sort(compareText);
}

export function validateDocumentPortableCandidate(input: Readonly<{
  pages: readonly CandidatePage[];
  activeReadablePagePaths: readonly string[];
  removedReadablePagePaths?: readonly string[];
}>): void {
  const pageByPath = new Map(input.pages.map((page) => [page.logicalPath, page]));
  const removedPaths = new Set((input.removedReadablePagePaths ?? [])
    .map(normalizeCandidatePath));
  const availablePaths = new Set([
    ...input.activeReadablePagePaths.filter((path) =>
      !removedPaths.has(normalizeCandidatePath(path))),
    ...input.pages.map((page) => page.logicalPath)
  ]);
  const readablePages = new Set([...availablePaths]
    .filter((path) => path.startsWith("pages/") && path.endsWith(".md"))
    .map(normalizePortablePagePath));

  for (const page of input.pages.filter((item) => item.logicalPath.endsWith(".json"))) {
    const value = parseJson(page);
    const records = portableRecords(page);
    for (const target of recordResourcePaths(value)) {
      if (!availablePaths.has(target)) {
        throw candidateError("portable_route_unreadable", page.logicalPath, target);
      }
    }
    for (const record of records) {
      for (const path of recordPagePaths(record)) {
        if (!readablePages.has(normalizePortablePagePath(path))) {
          throw candidateError("portable_endpoint_unreadable", page.logicalPath, path);
        }
      }
      if (page.logicalPath.startsWith("_graph/by-file/")) {
        const sourcePath = pagePathFromPortableByFileGraphPath(page.logicalPath);
        if (record.path !== sourcePath
          || portableByFileGraphPath(String(record.path)) !== page.logicalPath) {
          throw candidateError("portable_graph_location_mismatch", page.logicalPath);
        }
      }
      if (portableSemanticResourceFamilyForPath(page.logicalPath) === "documents") {
        validateDocumentIntegrity(record, pageByPath, page.logicalPath);
      }
    }
  }
}

function normalizeCandidatePath(path: string): string {
  return path.normalize("NFKC").toLocaleLowerCase("en-US");
}

function portableRecords(page: CandidatePage): Record<string, unknown>[] {
  try {
    return parseDocumentPortableRecords(page.bytes, page.logicalPath)
      .map((record) => ({ ...record }));
  } catch {
    throw candidateError("portable_record_invalid", page.logicalPath);
  }
}

function parseJson(page: CandidatePage): Record<string, unknown> {
  try {
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(page.bytes)
    );
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("invalid");
    }
    return value as Record<string, unknown>;
  } catch {
    throw candidateError("portable_json_invalid", page.logicalPath);
  }
}

function recordResourcePaths(record: Readonly<Record<string, unknown>>): string[] {
  const result: unknown[] = [];
  if (typeof record.parentPath === "string") result.push(record.parentPath);
  for (const key of ["resources", "childDirectories", "routes"] as const) {
    if (!Array.isArray(record[key])) continue;
    result.push(...record[key].map((item) =>
      typeof item === "object" && item !== null
        ? (item as { path?: unknown }).path : null));
  }
  if (typeof record.indexPath === "string") result.push(record.indexPath);
  if (typeof record.directoryGraphPath === "string") {
    result.push(record.directoryGraphPath);
  }
  return result.filter((path): path is string => typeof path === "string");
}

function recordPagePaths(record: Readonly<Record<string, unknown>>): string[] {
  const paths: unknown[] = [record.path, record.from, record.to, record.targetPath];
  if (Array.isArray(record.postings)) {
    paths.push(...record.postings.map((item) =>
      typeof item === "object" && item !== null
        ? (item as { path?: unknown }).path : null));
  }
  if (Array.isArray(record.evidence)) {
    paths.push(...record.evidence.map((item) =>
      typeof item === "object" && item !== null
        ? (item as { path?: unknown }).path : null));
  }
  if (Array.isArray(record.relationships)) {
    for (const relationship of record.relationships) {
      if (typeof relationship !== "object" || relationship === null) continue;
      const item = relationship as { targetPath?: unknown; evidence?: unknown };
      paths.push(item.targetPath);
      if (Array.isArray(item.evidence)) {
        paths.push(...item.evidence.map((evidence) =>
          typeof evidence === "object" && evidence !== null
            ? (evidence as { path?: unknown }).path : null));
      }
    }
  }
  return paths.filter((path): path is string =>
    typeof path === "string" && path.startsWith("pages/"));
}

function validateDocumentIntegrity(
  record: Readonly<Record<string, unknown>>,
  pageByPath: ReadonlyMap<string, CandidatePage>,
  resourcePath: string
): void {
  const path = typeof record.path === "string" ? record.path : "";
  const sourcePage = pageByPath.get(path);
  if (!sourcePage) return;
  if (record.checksumSha256 !== sourcePage.checksumSha256
    || record.byteCount !== sourcePage.byteCount) {
    throw candidateError("portable_document_integrity_mismatch", resourcePath);
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function candidateError(
  code: string,
  resourcePath: string,
  targetPath?: string
): Error & {
  code: string;
  resourcePath: string;
  targetPath?: string;
} {
  return Object.assign(new Error("Portable generated candidate is invalid"), {
    code,
    resourcePath,
    ...(targetPath ? { targetPath } : {})
  });
}
