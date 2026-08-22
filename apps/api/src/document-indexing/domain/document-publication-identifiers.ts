type Brand<Value, Name extends string> = Value & {
  readonly __documentPublicationBrand: Name;
};

export type DocumentFactEpoch = Brand<number, "fact_epoch">;
export type DocumentPublicationGenerationId = Brand<
  string,
  "publication_generation_id"
>;
export type DocumentScopeGeneration = Brand<number, "scope_generation">;
export type DocumentLeaseGeneration = Brand<number, "lease_generation">;
export type DocumentWorkAttempt = Brand<number, "work_attempt">;

export function documentFactEpoch(value: number): DocumentFactEpoch {
  return positiveVersion(
    value,
    "DOCUMENT_FACT_EPOCH_INVALID"
  ) as DocumentFactEpoch;
}

export function documentPublicationGenerationId(
  value: string
): DocumentPublicationGenerationId {
  if (!value || Buffer.byteLength(value, "utf8") > 255) {
    throw new Error("DOCUMENT_PUBLICATION_GENERATION_ID_INVALID");
  }
  return value as DocumentPublicationGenerationId;
}

export function documentScopeGeneration(
  value: number
): DocumentScopeGeneration {
  return positiveVersion(
    value,
    "DOCUMENT_SCOPE_GENERATION_INVALID"
  ) as DocumentScopeGeneration;
}

export function documentLeaseGeneration(
  value: number
): DocumentLeaseGeneration {
  return positiveVersion(
    value,
    "DOCUMENT_LEASE_GENERATION_INVALID"
  ) as DocumentLeaseGeneration;
}

export function documentWorkAttempt(value: number): DocumentWorkAttempt {
  return positiveVersion(
    value,
    "DOCUMENT_WORK_ATTEMPT_INVALID"
  ) as DocumentWorkAttempt;
}

function positiveVersion(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(code);
  return value;
}
