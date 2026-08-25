import { createHash } from "node:crypto";
import {
  assertPortableRecord,
  comparePortableRecordKeys,
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

type DocumentSemanticPacketConfiguration = Readonly<{
  family: PacketFamily;
  directoryPath: string;
  subject: string;
  title: string;
  scopePath?: string;
  prefix?: string;
  recordKey(record: Readonly<Record<string, unknown>>): string;
  maximumRecords: number;
  maximumBytes: number;
}>;

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
  const records = input.family === "term_postings"
    ? normalizeTermPacketRecords(input.records) : input.records;
  const ordered = expandOversizedTermRecords(input, records.slice().sort(
    (left, right) => comparePortableRecordKeys(
      input.recordKey(left), input.recordKey(right))
  ));
  const accumulator = createDocumentSemanticPacketAccumulator(input);
  accumulator.append(ordered);
  return accumulator.finish();
}

function normalizeTermPacketRecords(
  records: readonly Record<string, unknown>[]
): Record<string, unknown>[] {
  const terms = new Map<string, Map<string, Set<string>>>();
  for (const record of records) {
    if (typeof record.term !== "string" || !Array.isArray(record.postings)) {
      throw packetError("term_packet_record_invalid");
    }
    const postings = terms.get(record.term) ?? new Map<string, Set<string>>();
    for (const value of record.postings) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw packetError("term_packet_posting_invalid");
      }
      const posting = value as Record<string, unknown>;
      if (typeof posting.path !== "string" || !Array.isArray(posting.fields)
        || posting.fields.some((field) => typeof field !== "string")) {
        throw packetError("term_packet_posting_invalid");
      }
      const fields = postings.get(posting.path) ?? new Set<string>();
      posting.fields.forEach((field) => fields.add(field as string));
      postings.set(posting.path, fields);
    }
    terms.set(record.term, postings);
  }
  return [...terms.entries()].sort(([left], [right]) =>
    comparePortableRecordKeys(left, right)).map(([term, postings]) => ({
    term,
    postings: [...postings.entries()].sort(([left], [right]) =>
      comparePortableRecordKeys(left, right)).map(([path, fields]) => ({
      path,
      fields: [...fields].sort(comparePortableRecordKeys)
    }))
  }));
}

export function createDocumentSemanticPacketAccumulator(
  input: DocumentSemanticPacketConfiguration
) {
  if (!Number.isSafeInteger(input.maximumRecords) || input.maximumRecords < 1
    || !Number.isSafeInteger(input.maximumBytes) || input.maximumBytes < 1_024) {
    throw packetError("packet_limits_invalid");
  }
  const chunks: Array<{
    bytes: Uint8Array;
    recordCount: number;
    firstKey: string;
    lastKey: string;
  }> = [];
  let current: Record<string, unknown>[] = [];
  let currentBytes = packetByteLength(input, []);
  let lastKey: string | null = null;
  let finished = false;

  function flush(): void {
    if (current.length === 0) return;
    chunks.push({
      bytes: encodePacket(input, current),
      recordCount: current.length,
      firstKey: input.recordKey(current[0]!),
      lastKey: input.recordKey(current.at(-1)!)
    });
    current = [];
    currentBytes = packetByteLength(input, []);
  }

  return {
    append(records: readonly Record<string, unknown>[]): void {
      if (finished) throw packetError("packet_accumulator_finished");
      for (const record of records) {
        const key = input.recordKey(record);
        if (lastKey !== null && comparePortableRecordKeys(lastKey, key) > 0) {
          throw packetError("packet_records_unordered");
        }
        if (current.length > 0
          && input.recordKey(current.at(-1)!) === key) {
          flush();
        }
        const candidateBytes = currentBytes + (current.length > 0 ? 1 : 0)
          + jsonByteLength(record);
        if (current.length + 1 > input.maximumRecords
          || candidateBytes > input.maximumBytes) {
          if (current.length === 0) {
            throw packetError("packet_record_too_large");
          }
          flush();
          current = [record];
          currentBytes = packetByteLength(input, current);
          if (currentBytes > input.maximumBytes) {
            throw packetError("packet_record_too_large");
          }
        } else {
          current.push(record);
          currentBytes = candidateBytes;
        }
        lastKey = key;
      }
    },
    finish(): Readonly<{
      pages: readonly DocumentSemanticMachinePage[];
      descriptors: readonly DocumentSemanticPartDescriptor[];
    }> {
      if (finished) throw packetError("packet_accumulator_finished");
      finished = true;
      flush();
      const pages = chunks.map((chunk, index) => {
        const logicalPath = `${input.directoryPath}/${
          portableSemanticResourceFileName({
            subject: input.subject,
            family: packetResourceFamily(input.family),
            ...(chunks.length === 1 ? {} : { partNumber: index + 1 })
          })}`;
        return semanticMachinePage(
          logicalPath,
          input.family === "relationship_packet" ? "graph" : "index",
          chunk.bytes
        );
      });
      return {
        pages,
        descriptors: pages.map((page, index) => ({
          path: page.logicalPath,
          recordCount: chunks[index]!.recordCount,
          firstKey: chunks[index]!.firstKey,
          lastKey: chunks[index]!.lastKey,
          byteCount: page.byteCount
        }))
      };
    }
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
  assertSemanticPortableRecord(input.family, input.value);
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
  assertSemanticPortableRecord(input.family, value);
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function assertSemanticPortableRecord(
  family: PortableRecordFamily,
  value: unknown
): void {
  try {
    assertPortableRecord(family, value);
  } catch (error) {
    if (typeof error === "object" && error !== null) {
      Object.assign(error, { recordFamily: family });
    }
    throw error;
  }
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

function packetError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document semantic packet error: ${code}`), { code });
}
