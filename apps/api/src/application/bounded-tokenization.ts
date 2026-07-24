import type { LexicalTokenizer } from "./ports/lexical-tokenizer.js";

export const LEXICAL_DOCUMENT_CHUNK_MAX_CHARS = 4_096;

export function tokenizeBoundedDocument(
  tokenizer: LexicalTokenizer,
  value: string,
  limit: number
): string[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("Document token limit is invalid");
  }
  const chunks = selectDistributedChunks(splitDocument(value), limit);
  if (chunks.length === 0) return [];
  const perChunkLimit = Math.max(1, Math.ceil(limit / chunks.length));
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const chunk of chunks) {
    for (const term of tokenizer.tokenizeDocument(chunk, perChunkLimit)) {
      if (!term || seen.has(term)) continue;
      seen.add(term);
      terms.push(term);
      if (terms.length >= limit) return terms;
    }
  }
  return terms;
}

function splitDocument(value: string): string[] {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < value.length) {
    let end = Math.min(value.length, offset + LEXICAL_DOCUMENT_CHUNK_MAX_CHARS);
    if (
      end < value.length
      && end > offset
      && isHighSurrogate(value.charCodeAt(end - 1))
    ) {
      end -= 1;
    }
    chunks.push(value.slice(offset, end));
    offset = end;
  }
  return chunks;
}

function selectDistributedChunks(chunks: string[], limit: number): string[] {
  if (chunks.length <= limit) return chunks;
  if (limit === 1) return [chunks[0]!];
  const selected: string[] = [];
  const selectedIndexes = new Set<number>();
  for (let index = 0; index < limit; index += 1) {
    const chunkIndex = Math.round(index * (chunks.length - 1) / (limit - 1));
    if (selectedIndexes.has(chunkIndex)) continue;
    selectedIndexes.add(chunkIndex);
    selected.push(chunks[chunkIndex]!);
  }
  return selected;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}
