import { createHash } from "node:crypto";

export const SEARCH_CONTENT_SCHEMA_VERSION = "content-segment-v1";

export type ContentSegmentDocument = {
  id: string;
  knowledgeBaseId: string;
  sourceFileId: string;
  sourceRevisionId: string;
  pathRevision: number;
  logicalPath: string;
  fileKind: string;
  title: string | null;
  headingPath: string[];
  body: string;
  metadata: Record<string, unknown>;
  metadataText: string;
  sourceUrl: string | null;
  checksumSha256: string;
  segmentOrdinal: number;
  segmentTotal: number;
  visibleFromEpoch: number;
  visibleUntilEpoch: number | null;
  schemaVersion: string;
};

export type ContentSegmentInput = {
  knowledgeBaseId: string;
  sourceFileId: string;
  sourceRevisionId: string;
  pathRevision: number;
  logicalPath: string;
  fileKind: string;
  content: string;
  title: string | null;
  metadata: Record<string, unknown>;
  sourceUrl: string | null;
  checksumSha256: string;
  visibleFromEpoch: number;
  visibleUntilEpoch: number | null;
  maxSegmentBytes: number;
};

type SegmentPart = {
  headingPath: string[];
  body: string;
};

export function* mapMarkdownContentSegments(
  input: ContentSegmentInput
): Generator<ContentSegmentDocument> {
  if (!Number.isSafeInteger(input.maxSegmentBytes) || input.maxSegmentBytes < 64) {
    throw new Error("Search segment byte budget must be at least 64 bytes");
  }

  const parts = splitMarkdown(input.content, input.maxSegmentBytes);
  const normalizedParts = parts.length > 0
    ? parts
    : [{ headingPath: [], body: "" }];
  const metadata = normalizeSearchMetadata(input.metadata);
  const metadataText = Object.keys(metadata).length > 0
    ? stableSearchJson(metadata)
    : "";
  const segmentTotal = normalizedParts.length;

  for (const [segmentOrdinal, part] of normalizedParts.entries()) {
    yield {
      id: createContentSegmentId(input, segmentOrdinal),
      knowledgeBaseId: input.knowledgeBaseId,
      sourceFileId: input.sourceFileId,
      sourceRevisionId: input.sourceRevisionId,
      pathRevision: input.pathRevision,
      logicalPath: input.logicalPath,
      fileKind: input.fileKind,
      title: input.title,
      headingPath: part.headingPath,
      body: part.body,
      metadata,
      metadataText,
      sourceUrl: input.sourceUrl,
      checksumSha256: input.checksumSha256,
      segmentOrdinal,
      segmentTotal,
      visibleFromEpoch: input.visibleFromEpoch,
      visibleUntilEpoch: input.visibleUntilEpoch,
      schemaVersion: SEARCH_CONTENT_SCHEMA_VERSION
    };
  }
}

function splitMarkdown(content: string, maxBytes: number): SegmentPart[] {
  const blocks = markdownBlocks(content);
  const output: SegmentPart[] = [];
  let current: SegmentPart | null = null;

  for (const block of blocks) {
    for (const chunk of splitUtf8(block.body, maxBytes)) {
      const canAppend = current
        && arraysEqual(current.headingPath, block.headingPath)
        && Buffer.byteLength(`${current.body}\n\n${chunk}`, "utf8") <= maxBytes;
      if (canAppend && current) {
        current.body = `${current.body}\n\n${chunk}`;
        continue;
      }
      current = {
        headingPath: [...block.headingPath],
        body: chunk
      };
      output.push(current);
    }
  }

  return output;
}

function markdownBlocks(content: string): SegmentPart[] {
  const normalized = content.replace(/\r\n?/gu, "\n").trim();
  if (!normalized) return [];

  const headingPath: string[] = [];
  const blocks: SegmentPart[] = [];
  let lines: string[] = [];
  let blockHeadingPath: string[] = [];

  const flush = () => {
    const body = lines.join("\n").trim();
    if (body) {
      blocks.push({
        headingPath: [...blockHeadingPath],
        body
      });
    }
    lines = [];
  };

  for (const line of normalized.split("\n")) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (heading) {
      flush();
      const level = heading[1]!.length;
      headingPath.length = level - 1;
      headingPath[level - 1] = heading[2]!.trim();
      blockHeadingPath = [...headingPath];
      lines.push(line.trim());
      continue;
    }

    if (!line.trim()) {
      flush();
      blockHeadingPath = [...headingPath];
      continue;
    }

    if (lines.length === 0) blockHeadingPath = [...headingPath];
    lines.push(line);
  }
  flush();

  return blocks;
}

function splitUtf8(value: string, maxBytes: number): string[] {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return [value];
  const chunks: string[] = [];
  let current = "";
  let bytes = 0;

  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes && current) {
      chunks.push(current);
      current = "";
      bytes = 0;
    }
    current += character;
    bytes += characterBytes;
  }
  if (current) chunks.push(current);
  return chunks;
}

export function createContentSegmentId(
  input: Pick<
    ContentSegmentInput,
    | "knowledgeBaseId"
    | "sourceFileId"
    | "sourceRevisionId"
    | "pathRevision"
  >,
  segmentOrdinal: number
): string {
  return createHash("sha256")
    .update(stableSearchJson([
      SEARCH_CONTENT_SCHEMA_VERSION,
      input.knowledgeBaseId,
      input.sourceFileId,
      input.sourceRevisionId,
      input.pathRevision,
      segmentOrdinal
    ]))
    .digest("hex");
}

export function normalizeSearchMetadata(
  value: Record<string, unknown>
): Record<string, unknown> {
  const normalized = normalizeValue(value, 0);
  if (!normalized || Array.isArray(normalized) || typeof normalized !== "object") return {};
  const serialized = stableSearchJson(normalized);
  if (Buffer.byteLength(serialized, "utf8") <= 4_096) {
    return normalized as Record<string, unknown>;
  }
  return {};
}

function normalizeValue(value: unknown, depth: number): unknown {
  if (depth > 4 || value === null) return value === null ? null : undefined;
  if (typeof value === "string") return value.slice(0, 1_024);
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value
      .slice(0, 50)
      .map((item) => normalizeValue(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, 50)
        .flatMap(([key, item]) => {
          const normalized = normalizeValue(item, depth + 1);
          return normalized === undefined ? [] : [[key, normalized]];
        })
    );
  }
  return undefined;
}

export function stableSearchJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSearchJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSearchJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}
