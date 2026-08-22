export type DocumentPublicationActivationLockFamily =
  | "source" | "relation" | "search" | "page" | "directory"
  | "job" | "receipt" | "outbox";

const FAMILY_ORDER: readonly DocumentPublicationActivationLockFamily[] = [
  "source", "relation", "search", "page", "directory",
  "job", "receipt", "outbox"
];

export function documentPublicationActivationLockOrder(input: Readonly<{
  sourceFilePublicIds: readonly string[];
  relationPublicIds: readonly string[];
  searchOwnerKeys: readonly string[];
  normalizedPaths: readonly string[];
  directoryPaths: readonly string[];
  documentJobPublicIds: readonly string[];
  receiptPublicIds: readonly string[];
  outboxPublicIds: readonly string[];
}>) {
  const values: Record<DocumentPublicationActivationLockFamily,
    readonly string[]> = {
    source: input.sourceFilePublicIds,
    relation: input.relationPublicIds,
    search: input.searchOwnerKeys,
    page: input.normalizedPaths,
    directory: input.directoryPaths,
    job: input.documentJobPublicIds,
    receipt: input.receiptPublicIds,
    outbox: input.outboxPublicIds
  };
  return FAMILY_ORDER.flatMap((family) =>
    [...new Set(values[family])].sort(bytewise).map((key) => ({ family, key })));
}

export function documentPublicationContentionDecision(input: Readonly<{
  code: string;
  attempt: number;
  maximumAttempts: number;
  random: number;
}>) {
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1
    || !Number.isSafeInteger(input.maximumAttempts)
    || input.maximumAttempts < 1 || input.maximumAttempts > 10
    || input.random < 0 || input.random >= 1) {
    throw new Error("DOCUMENT_PUBLICATION_CONTENTION_INPUT_INVALID");
  }
  if (!["40P01", "40001", "55P03"].includes(input.code)) {
    return { action: "fail" as const, delayMilliseconds: 0,
      consumesBusinessAttempt: true };
  }
  if (input.attempt >= input.maximumAttempts) {
    return { action: "defer" as const, delayMilliseconds: 0,
      consumesBusinessAttempt: false };
  }
  const maximumDelay = Math.min(1_000, 25 * 2 ** (input.attempt - 1));
  return {
    action: "retry" as const,
    delayMilliseconds: Math.floor(maximumDelay * input.random),
    consumesBusinessAttempt: false
  };
}

export function planDocumentPublicationActivationReservations(input: Readonly<{
  documents: readonly Readonly<{
    documentJobPublicId: string | null;
    sourceFilePublicId: string;
    relatedSourceFilePublicIds: readonly string[];
  }>[];
  putPaths: readonly string[];
  deletePaths: readonly string[];
  searchSourceFilePublicIds: readonly string[];
  directoryPaths: readonly string[];
}>) {
  const reservations: {
    family: DocumentPublicationActivationLockFamily;
    key: string;
  }[] = [];
  for (const document of input.documents) {
    reservations.push({ family: "source", key: document.sourceFilePublicId });
    if (document.documentJobPublicId) reservations.push(
      { family: "job", key: document.documentJobPublicId },
      { family: "receipt",
        key: `${document.documentJobPublicId}:generated_page:closure` },
      { family: "receipt",
        key: `${document.documentJobPublicId}:activation:visible` },
      { family: "outbox",
        key: `${document.documentJobPublicId}:projection-cleanup` }
    );
    for (const related of document.relatedSourceFilePublicIds) {
      reservations.push({
        family: "relation",
        key: encodeCompositeOwnerKey(
          [document.sourceFilePublicId, related].sort(bytewise)
        )
      });
    }
  }
  reservations.push(
    ...input.searchSourceFilePublicIds.map((key) => ({
      family: "search" as const, key
    })),
    ...[...input.putPaths, ...input.deletePaths].map((key) => ({
      family: "page" as const, key
    })),
    ...input.directoryPaths.map((key) => ({
      family: "directory" as const, key
    }))
  );
  return FAMILY_ORDER.flatMap((family) => [...new Map(reservations
    .filter((item) => item.family === family)
    .map((item) => [item.key, item])).values()].sort((left, right) =>
      bytewise(left.key, right.key)));
}

export function encodeCompositeOwnerKey(parts: readonly string[]): string {
  return parts.map((part) => `${Buffer.byteLength(part, "utf8")}:${part}`).join("");
}

function bytewise(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
