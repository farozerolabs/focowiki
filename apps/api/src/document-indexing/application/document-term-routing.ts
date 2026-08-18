import type { DocumentNavigationTermField } from
  "./document-navigation-terms.js";

export const DOCUMENT_TERM_BUCKETS = [
  "latin", "han", "kana", "hangul", "number", "other"
] as const;
export type DocumentTermBucket = typeof DOCUMENT_TERM_BUCKETS[number];

export type DocumentTermPosting = Readonly<{
  path: string;
  fields: readonly DocumentNavigationTermField[];
}>;

export type DocumentTermRecord = Readonly<{
  term: string;
  postings: readonly DocumentTermPosting[];
}>;

export function classifyDocumentNavigationTerm(term: string): DocumentTermBucket {
  const codePoint = term.normalize("NFKC").codePointAt(0);
  if (codePoint === undefined) return "other";
  if (isAsciiNumber(codePoint) || isFullWidthNumber(codePoint)) return "number";
  if (isLatin(codePoint)) return "latin";
  if (isHan(codePoint)) return "han";
  if (isKana(codePoint)) return "kana";
  if (isHangul(codePoint)) return "hangul";
  return "other";
}

export function partitionDocumentNavigationTerms(
  records: readonly DocumentTermRecord[],
  options: Readonly<{ maximumRecordsPerPart: number }>
): ReadonlyArray<Readonly<{
  bucket: DocumentTermBucket;
  path: string;
  firstTerm: string;
  lastTerm: string;
  recordCount: number;
  terms: readonly DocumentTermRecord[];
}>> {
  if (!Number.isSafeInteger(options.maximumRecordsPerPart)
    || options.maximumRecordsPerPart < 1) {
    throw new Error("document_term_part_limit_invalid");
  }
  const byBucket = new Map<DocumentTermBucket, DocumentTermRecord[]>();
  for (const record of records) {
    const bucket = classifyDocumentNavigationTerm(record.term);
    const bucketRecords = byBucket.get(bucket) ?? [];
    bucketRecords.push(record);
    byBucket.set(bucket, bucketRecords);
  }
  return DOCUMENT_TERM_BUCKETS.flatMap((bucket) => {
    const ordered = (byBucket.get(bucket) ?? []).slice().sort((left, right) =>
      compareText(left.term, right.term));
    const parts = [];
    for (let offset = 0; offset < ordered.length;
      offset += options.maximumRecordsPerPart) {
      const terms = ordered.slice(offset, offset + options.maximumRecordsPerPart);
      const partNumber = Math.floor(offset / options.maximumRecordsPerPart) + 1;
      parts.push({
        bucket,
        path: `_index/terms/${bucket}/${bucket}-terms-part-${String(partNumber)
          .padStart(4, "0")}.json`,
        firstTerm: terms[0]!.term,
        lastTerm: terms.at(-1)!.term,
        recordCount: terms.length,
        terms
      });
    }
    return parts;
  });
}

function isAsciiNumber(value: number): boolean {
  return value >= 0x30 && value <= 0x39;
}

function isFullWidthNumber(value: number): boolean {
  return value >= 0xff10 && value <= 0xff19;
}

function isLatin(value: number): boolean {
  return (value >= 0x41 && value <= 0x5a)
    || (value >= 0x61 && value <= 0x7a)
    || (value >= 0xc0 && value <= 0x24f)
    || (value >= 0x1e00 && value <= 0x1eff);
}

function isHan(value: number): boolean {
  return (value >= 0x3400 && value <= 0x4dbf)
    || (value >= 0x4e00 && value <= 0x9fff)
    || (value >= 0xf900 && value <= 0xfaff)
    || (value >= 0x20000 && value <= 0x323af);
}

function isKana(value: number): boolean {
  return (value >= 0x3040 && value <= 0x30ff)
    || (value >= 0x31f0 && value <= 0x31ff)
    || (value >= 0xff65 && value <= 0xff9f);
}

function isHangul(value: number): boolean {
  return (value >= 0x1100 && value <= 0x11ff)
    || (value >= 0x3130 && value <= 0x318f)
    || (value >= 0xac00 && value <= 0xd7af);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
