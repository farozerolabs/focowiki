import { createHash } from "node:crypto";

export type SemanticSourceChunk = {
  id: string;
  text: string;
  startOffset: number;
  endOffset: number;
};

export function createSemanticSourceChunks(input: {
  sourceRevisionPublicId: string;
  markdown: string;
  maximumChunkCharacters: number;
  maximumChunks: number;
}): SemanticSourceChunk[] {
  assertLimits(input);
  if (!input.markdown.trim()) {
    throw Object.assign(new Error("Semantic source body is empty"), {
      code: "semantic_source_body_empty",
      retryable: false
    });
  }
  const chunks: SemanticSourceChunk[] = [];
  let offset = 0;
  while (offset < input.markdown.length) {
    if (chunks.length >= input.maximumChunks) {
      throw Object.assign(new Error("Semantic source exceeds the bounded extraction manifest"), {
        code: "semantic_source_chunk_limit",
        retryable: false
      });
    }
    const hardEnd = Math.min(input.markdown.length, offset + input.maximumChunkCharacters);
    const end = hardEnd === input.markdown.length
      ? hardEnd
      : selectBoundary(input.markdown, offset, hardEnd);
    const text = input.markdown.slice(offset, end);
    chunks.push({
      id: `chunk-${String(chunks.length + 1).padStart(4, "0")}-${createHash("sha256")
        .update(`${input.sourceRevisionPublicId}\u001f${offset}\u001f${end}\u001f${text}`)
        .digest("hex")
        .slice(0, 16)}`,
      text,
      startOffset: offset,
      endOffset: end
    });
    offset = end;
  }
  return chunks;
}

export function semanticChunkManifestHash(
  chunks: readonly Pick<SemanticSourceChunk, "id" | "text">[]
): string {
  const canonical = JSON.stringify([...chunks]
    .map(({ id, text }) => ({ id, text }))
    .sort((left, right) => left.id.localeCompare(right.id, "en")));
  return createHash("sha256").update(canonical).digest("hex");
}

function selectBoundary(markdown: string, start: number, hardEnd: number): number {
  const minimum = start + Math.floor((hardEnd - start) * 0.6);
  const paragraph = markdown.lastIndexOf("\n\n", hardEnd - 2);
  if (paragraph >= minimum) return paragraph + 2;
  const line = markdown.lastIndexOf("\n", hardEnd - 1);
  if (line >= minimum) return line + 1;
  if (hardEnd - 1 > start
    && isHighSurrogate(markdown.charCodeAt(hardEnd - 1))) {
    return hardEnd - 1;
  }
  return hardEnd;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function assertLimits(input: {
  sourceRevisionPublicId: string;
  maximumChunkCharacters: number;
  maximumChunks: number;
}): void {
  if (!input.sourceRevisionPublicId
    || !Number.isSafeInteger(input.maximumChunkCharacters)
    || input.maximumChunkCharacters < 1
    || input.maximumChunkCharacters > 64_000
    || !Number.isSafeInteger(input.maximumChunks)
    || input.maximumChunks < 1
    || input.maximumChunks > 32) {
    throw new Error("Semantic source chunk settings are invalid");
  }
}
