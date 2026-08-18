export const DOCUMENT_EVIDENCE_EXCERPT_MAX_BYTES = 8_192;

export function truncateDocumentUtf8(value: string, maximumBytes: number): string {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new Error("Document UTF-8 byte bound is invalid");
  }
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximumBytes) return value;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = maximumBytes; end > 0; end -= 1) {
    try {
      return decoder.decode(bytes.subarray(0, end));
    } catch {
      continue;
    }
  }
  return "";
}

export function selectDocumentRankingTerms(
  values: readonly string[],
  maximumItems: number,
  maximumBytesPerTerm: number
): string[] {
  if (!Number.isSafeInteger(maximumItems) || maximumItems < 0
    || !Number.isSafeInteger(maximumBytesPerTerm)
    || maximumBytesPerTerm < 1) {
    throw new Error("Document ranking term bound is invalid");
  }
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.normalize("NFKC").trim();
    if (!normalized
      || Buffer.byteLength(normalized, "utf8") > maximumBytesPerTerm) {
      continue;
    }
    const key = normalized.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(normalized);
    if (selected.length === maximumItems) break;
  }
  return selected;
}
