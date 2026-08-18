import { createHash } from "node:crypto";
import {
  assertPortableRecord,
  portableSemanticResourceFileName,
  type PortableRecordFamily,
  type PortableSemanticResourceFamily
} from "@focowiki/okf";

export type DocumentSemanticMachinePage = ReturnType<typeof semanticMachinePage>;
export type DocumentSemanticPartDescriptor = Readonly<{
  path: string;
  recordCount: number;
  firstKey: string;
  lastKey: string;
  byteCount: number;
}>;

type PacketFamily = "document_packet" | "term_postings" | "relationship_packet";

export function buildDocumentSemanticPacketPages(input: Readonly<{
  family: PacketFamily;
  directoryPath: string;
  subject: string;
  title: string;
  scopePath?: string;
  prefix?: string;
  records: readonly Record<string, unknown>[];
  recordKey(record: Readonly<Record<string, unknown>>): string;
  maximumRecords: number;
  maximumBytes: number;
}>): Readonly<{
  pages: readonly DocumentSemanticMachinePage[];
  descriptors: readonly DocumentSemanticPartDescriptor[];
}> {
  if (!Number.isSafeInteger(input.maximumRecords) || input.maximumRecords < 1
    || !Number.isSafeInteger(input.maximumBytes) || input.maximumBytes < 1_024) {
    throw packetError("packet_limits_invalid");
  }
  if (input.records.length === 0) return { pages: [], descriptors: [] };
  const ordered = expandOversizedTermRecords(input, input.records.slice().sort(
    (left, right) => compareText(input.recordKey(left), input.recordKey(right))
  ));
  const chunks: Record<string, unknown>[][] = [];
  let current: Record<string, unknown>[] = [];
  let currentBytes = packetByteLength(input, []);
  for (const record of ordered) {
    if (current.length > 0
      && input.recordKey(current.at(-1)!) === input.recordKey(record)) {
      chunks.push(current);
      current = [];
      currentBytes = packetByteLength(input, []);
    }
    const candidateBytes = currentBytes + (current.length > 0 ? 1 : 0)
      + jsonByteLength(record);
    if (current.length + 1 > input.maximumRecords
      || candidateBytes > input.maximumBytes) {
      if (current.length === 0) throw packetError("packet_record_too_large");
      chunks.push(current);
      current = [record];
      currentBytes = packetByteLength(input, current);
      if (currentBytes > input.maximumBytes) {
        throw packetError("packet_record_too_large");
      }
    } else {
      current.push(record);
      currentBytes = candidateBytes;
    }
  }
  if (current.length > 0) chunks.push(current);

  const pages = chunks.map((records, index) => {
    const logicalPath = `${input.directoryPath}/${portableSemanticResourceFileName({
      subject: input.subject,
      family: packetResourceFamily(input.family),
      ...(chunks.length === 1 ? {} : { partNumber: index + 1 })
    })}`;
    return semanticMachinePage(
      logicalPath,
      input.family === "relationship_packet" ? "graph" : "index",
      encodePacket(input, records)
    );
  });
  return {
    pages,
    descriptors: pages.map((page, index) => ({
      path: page.logicalPath,
      recordCount: chunks[index]!.length,
      firstKey: input.recordKey(chunks[index]![0]!),
      lastKey: input.recordKey(chunks[index]!.at(-1)!),
      byteCount: page.byteCount
    }))
  };
}

function packetResourceFamily(family: PacketFamily): PortableSemanticResourceFamily {
  if (family === "document_packet") return "documents";
  if (family === "relationship_packet") return "relationships";
  return "terms";
}

function expandOversizedTermRecords(
  input: Parameters<typeof buildDocumentSemanticPacketPages>[0],
  records: readonly Record<string, unknown>[]
): Record<string, unknown>[] {
  if (input.family !== "term_postings") return [...records];
  return records.flatMap((record) => {
    if (packetByteLength(input, [record]) <= input.maximumBytes) return [record];
    if (!Array.isArray(record.postings) || record.postings.length === 0) {
      throw packetError("packet_record_too_large");
    }
    const parts: Record<string, unknown>[] = [];
    let postings: unknown[] = [];
    let currentBytes = packetByteLength(input, [{ ...record, postings: [] }]);
    for (const posting of record.postings) {
      const candidateBytes = currentBytes + (postings.length > 0 ? 1 : 0)
        + jsonByteLength(posting);
      if (candidateBytes > input.maximumBytes) {
        if (postings.length === 0) throw packetError("packet_record_too_large");
        parts.push({ ...record, postings });
        postings = [posting];
        currentBytes = packetByteLength(input, [{ ...record, postings }]);
        if (currentBytes > input.maximumBytes) {
          throw packetError("packet_record_too_large");
        }
      } else {
        postings.push(posting);
        currentBytes = candidateBytes;
      }
    }
    if (postings.length > 0) parts.push({ ...record, postings });
    return parts;
  });
}

export function jsonDocumentSemanticPage(input: Readonly<{
  logicalPath: string;
  entryKind: string;
  family: PortableRecordFamily;
  value: unknown;
}>): DocumentSemanticMachinePage {
  assertPortableRecord(input.family, input.value);
  return semanticMachinePage(
    input.logicalPath,
    input.entryKind,
    Buffer.from(`${JSON.stringify(input.value)}\n`, "utf8")
  );
}

function encodePacket(
  input: Pick<Parameters<typeof buildDocumentSemanticPacketPages>[0],
    "family" | "title" | "scopePath" | "prefix">,
  records: readonly Record<string, unknown>[]
): Uint8Array {
  const value = packetValue(input, records);
  assertPortableRecord(input.family, value);
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function packetValue(
  input: Pick<Parameters<typeof buildDocumentSemanticPacketPages>[0],
    "family" | "title" | "scopePath" | "prefix">,
  records: readonly Record<string, unknown>[]
): Record<string, unknown> {
  return input.family === "document_packet" ? {
    formatVersion: 2,
    title: input.title,
    scopePath: requiredString(input.scopePath),
    documents: records
  } : input.family === "relationship_packet" ? {
    formatVersion: 2,
    title: input.title,
    scopePath: requiredString(input.scopePath),
    relationships: records
  } : {
    formatVersion: 2,
    title: input.title,
    bucket: requiredString(input.prefix),
    terms: records
  };
}

function packetByteLength(
  input: Pick<Parameters<typeof buildDocumentSemanticPacketPages>[0],
    "family" | "title" | "scopePath" | "prefix">,
  records: readonly Record<string, unknown>[]
): number {
  return Buffer.byteLength(`${JSON.stringify(packetValue(input, records))}\n`, "utf8");
}

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function semanticMachinePage(
  logicalPath: string,
  entryKind: string,
  bytes: Uint8Array
) {
  return {
    logicalPath,
    normalizedPath: logicalPath.toLocaleLowerCase("en-US"),
    entryKind,
    sourceFilePublicId: null,
    sourceRevisionPublicId: null,
    bytes,
    byteCount: bytes.byteLength,
    checksumSha256: createHash("sha256").update(bytes).digest("hex")
  };
}

function requiredString(value: string | undefined): string {
  if (!value) throw packetError("packet_scope_missing");
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function packetError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document semantic packet error: ${code}`), { code });
}
