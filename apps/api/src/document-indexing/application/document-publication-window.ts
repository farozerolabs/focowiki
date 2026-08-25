export type ReadyDocumentPublicationFact = Readonly<{
  mutationPublicId: string;
  documentJobPublicId: string | null;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  factEpoch: number;
  readyAt: string;
}>;

export function monotonicDocumentPublicationTargetFactEpoch(
  candidateFactEpoch: number,
  activeFactEpoch: number
): number {
  if (!Number.isSafeInteger(candidateFactEpoch) || candidateFactEpoch < 1
    || !Number.isSafeInteger(activeFactEpoch) || activeFactEpoch < 0) {
    throw new Error("DOCUMENT_PUBLICATION_FACT_EPOCH_INVALID");
  }
  return Math.max(candidateFactEpoch, activeFactEpoch);
}

export function selectReadyDocumentPublicationWindow(input: Readonly<{
  documents: readonly ReadyDocumentPublicationFact[];
  now: string;
  contributorCap: number;
  inFlightDocumentCount?: number;
  minimumWindowMs?: number;
  maximumWindowMs?: number;
  bulkMinimumWindowMs?: number;
  bulkMaximumWindowMs?: number;
}>): Readonly<{
  documents: readonly ReadyDocumentPublicationFact[];
  targetFactEpoch: number;
  deterministicChangedAt: string;
  windowMilliseconds: number;
  inFlightDocumentCount: number;
}> | null {
  const minimum = input.minimumWindowMs ?? 25;
  const maximum = input.maximumWindowMs ?? 100;
  const bulkMinimum = input.bulkMinimumWindowMs ?? 5_000;
  const bulkMaximum = input.bulkMaximumWindowMs ?? 30_000;
  const inFlightDocumentCount = input.inFlightDocumentCount ?? 0;
  if (!Number.isSafeInteger(input.contributorCap)
    || input.contributorCap < 1 || input.contributorCap > 256
    || !Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum)
    || minimum < 25 || maximum > 100 || minimum > maximum
    || !Number.isSafeInteger(bulkMinimum)
    || !Number.isSafeInteger(bulkMaximum)
    || bulkMinimum < 100 || bulkMaximum > 30_000
    || bulkMinimum > bulkMaximum
    || !Number.isSafeInteger(inFlightDocumentCount)
    || inFlightDocumentCount < 0) {
    throw new Error("DOCUMENT_PUBLICATION_WINDOW_INVALID");
  }
  const now = Date.parse(input.now);
  if (!Number.isFinite(now)) throw new Error("DOCUMENT_PUBLICATION_TIME_INVALID");
  const unique = [...new Map(input.documents.map((document) => [
    document.mutationPublicId,
    validateDocument(document)
  ])).values()].sort((left, right) =>
    Date.parse(left.readyAt) - Date.parse(right.readyAt)
      || left.mutationPublicId.localeCompare(
        right.mutationPublicId,
        "en-US"
      ));
  if (unique.length === 0) return null;
  const pressure = Math.min(1, unique.length / input.contributorCap);
  const windowMilliseconds = inFlightDocumentCount > 0
    ? Math.round(bulkMaximum - (bulkMaximum - bulkMinimum) * pressure)
    : Math.round(maximum - (maximum - minimum) * pressure);
  const elapsed = now - Date.parse(unique[0]!.readyAt);
  if (unique.length < input.contributorCap && elapsed < windowMilliseconds) {
    return null;
  }
  const documents = unique.slice(0, input.contributorCap);
  return {
    documents,
    targetFactEpoch: Math.max(...documents.map((item) => item.factEpoch)),
    deterministicChangedAt: documents.reduce((latest, item) =>
      Date.parse(item.readyAt) > Date.parse(latest) ? item.readyAt : latest,
    documents[0]!.readyAt),
    windowMilliseconds,
    inFlightDocumentCount
  };
}

function validateDocument(
  input: ReadyDocumentPublicationFact
): ReadyDocumentPublicationFact {
  if (!input.mutationPublicId || !input.sourceFilePublicId
    || !input.sourceRevisionPublicId
    || !Number.isSafeInteger(input.factEpoch) || input.factEpoch < 1
    || !Number.isFinite(Date.parse(input.readyAt))) {
    throw new Error("DOCUMENT_PUBLICATION_FACT_INVALID");
  }
  return input;
}
