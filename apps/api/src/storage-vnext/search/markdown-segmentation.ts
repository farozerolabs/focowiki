import { createHash } from "node:crypto";

export const STORAGE_VNEXT_MARKDOWN_SEGMENTATION_VERSION =
  "storage-vnext-markdown-segmentation-v1";

export type StorageVnextMarkdownSegment = {
  id: string;
  ordinal: number;
  headingAncestors: readonly string[];
  searchText: string;
};

export async function* segmentStorageVnextMarkdown(input: {
  chunks: AsyncIterable<Uint8Array>;
  maxSegmentBytes: number;
  sourceRevisionPublicId: string;
}): AsyncGenerator<StorageVnextMarkdownSegment> {
  if (
    !Number.isSafeInteger(input.maxSegmentBytes)
    || input.maxSegmentBytes < 64
  ) {
    throw new Error("Search segment byte budget must be at least 64 bytes");
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const completed: StorageVnextMarkdownSegment[] = [];
  const headings: Array<string | undefined> = [];
  let pendingLine = "";
  let current: {
    headingAncestors: string[];
    searchText: string;
    bytes: number;
  } | null = null;
  let ordinal = 0;

  const flush = (): void => {
    if (!current || current.searchText.length === 0) return;
    completed.push({
      id: createSegmentId({
        sourceRevisionPublicId: input.sourceRevisionPublicId,
        ordinal,
        headingAncestors: current.headingAncestors,
        searchText: current.searchText
      }),
      ordinal,
      headingAncestors: current.headingAncestors,
      searchText: current.searchText
    });
    ordinal += 1;
    current = null;
  };

  const currentHeadings = (): string[] =>
    headings.filter((value): value is string => value !== undefined);

  const append = (value: string, headingAncestors: string[]): void => {
    let remaining = value;
    while (remaining.length > 0) {
      if (
        current
        && !sameHeadings(current.headingAncestors, headingAncestors)
      ) {
        flush();
      }
      if (!current) {
        current = {
          headingAncestors: [...headingAncestors],
          searchText: "",
          bytes: 0
        };
      }
      const available = input.maxSegmentBytes - current.bytes;
      const [part, rest] = takeUtf8Prefix(remaining, available);
      if (!part) {
        flush();
        continue;
      }
      current.searchText += part;
      current.bytes += Buffer.byteLength(part, "utf8");
      remaining = rest;
      if (current.bytes === input.maxSegmentBytes) flush();
    }
  };

  const processLine = (line: string): void => {
    const heading = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*(?:\r?\n)?$/u.exec(line);
    if (heading) {
      flush();
      const level = heading[1]!.length;
      headings.length = level;
      headings[level - 1] = heading[2]!.trim();
    }
    append(line, currentHeadings());
  };

  const yieldCompleted = async function* () {
    while (completed.length > 0) yield completed.shift()!;
  };

  for await (const chunk of input.chunks) {
    pendingLine += decoder.decode(chunk, { stream: true });
    let newline = pendingLine.indexOf("\n");
    while (newline >= 0) {
      processLine(pendingLine.slice(0, newline + 1));
      pendingLine = pendingLine.slice(newline + 1);
      yield* yieldCompleted();
      newline = pendingLine.indexOf("\n");
    }

    while (
      !couldBeHeading(pendingLine)
      && Buffer.byteLength(pendingLine, "utf8") > input.maxSegmentBytes
    ) {
      const [part, rest] = takeUtf8Prefix(
        pendingLine,
        input.maxSegmentBytes
      );
      append(part, currentHeadings());
      pendingLine = rest;
      yield* yieldCompleted();
    }
  }

  pendingLine += decoder.decode();
  if (pendingLine) processLine(pendingLine);
  flush();
  yield* yieldCompleted();
}

function createSegmentId(input: {
  sourceRevisionPublicId: string;
  ordinal: number;
  headingAncestors: readonly string[];
  searchText: string;
}): string {
  return "segment-" + createHash("sha256").update([
    STORAGE_VNEXT_MARKDOWN_SEGMENTATION_VERSION,
    input.sourceRevisionPublicId,
    String(input.ordinal),
    JSON.stringify(input.headingAncestors),
    input.searchText
  ].join("\u0000")).digest("hex");
}

function couldBeHeading(value: string): boolean {
  return /^#{0,6}(?:[ \t].*)?$/u.test(value);
}

function sameHeadings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function takeUtf8Prefix(value: string, maxBytes: number): [string, string] {
  if (maxBytes < 1) return ["", value];
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += character.length;
  }
  return [value.slice(0, end), value.slice(end)];
}
