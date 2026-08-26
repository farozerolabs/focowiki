export const DOCUMENT_PUBLICATION_ITEM_LIMIT = 256;
export const DOCUMENT_PUBLICATION_ATTEMPT_MILLISECONDS = 90 * 1_000;
export const DOCUMENT_PUBLICATION_HEARTBEAT_MILLISECONDS = 30 * 1_000;
export const DOCUMENT_PUBLICATION_MAXIMUM_ATTEMPTS = 3;

export const DOCUMENT_PUBLICATION_ITEM_OUTCOMES = [
  "pending", "committed", "failed", "superseded"
] as const;

export const DOCUMENT_PUBLICATION_JOB_OUTCOMES = [
  "pending", "committed", "failed"
] as const;

export type DocumentPublicationItemOutcome =
  (typeof DOCUMENT_PUBLICATION_ITEM_OUTCOMES)[number];
export type DocumentPublicationJobOutcome =
  (typeof DOCUMENT_PUBLICATION_JOB_OUTCOMES)[number];

export type DocumentPublicationMembershipCandidate = Readonly<{
  publicId: string;
  readinessSequence: number;
}>;

export function freezeDocumentPublicationMembership<
  T extends DocumentPublicationMembershipCandidate
>(items: readonly T[]): readonly Readonly<T>[] {
  const unique = new Map<string, T>();
  for (const item of items) {
    if (!item.publicId || !Number.isSafeInteger(item.readinessSequence)
      || item.readinessSequence < 1) {
      throw publicationDomainError("publication_item_identity_invalid");
    }
    const existing = unique.get(item.publicId);
    if (existing && existing.readinessSequence !== item.readinessSequence) {
      throw publicationDomainError("publication_item_identity_conflict");
    }
    unique.set(item.publicId, item);
  }
  return Object.freeze([...unique.values()]
    .sort((left, right) => left.readinessSequence - right.readinessSequence
      || bytewise(left.publicId, right.publicId))
    .slice(0, DOCUMENT_PUBLICATION_ITEM_LIMIT)
    .map((item) => Object.freeze({ ...item })));
}

export function assertOneNonterminalPublicationJob(
  jobs: readonly Readonly<{
    knowledgeBaseId: string;
    outcome: DocumentPublicationJobOutcome;
  }>[]
): void {
  const owners = new Set<string>();
  for (const job of jobs) {
    if (!job.knowledgeBaseId
      || !DOCUMENT_PUBLICATION_JOB_OUTCOMES.includes(job.outcome)) {
      throw publicationDomainError("publication_job_identity_invalid");
    }
    if (job.outcome !== "pending") continue;
    if (owners.has(job.knowledgeBaseId)) {
      throw publicationDomainError("publication_job_owner_conflict");
    }
    owners.add(job.knowledgeBaseId);
  }
}

export function publicationAttemptDeadline(claimedAt: string): string {
  const claimedAtMilliseconds = Date.parse(claimedAt);
  if (!Number.isFinite(claimedAtMilliseconds)) {
    throw publicationDomainError("publication_attempt_timestamp_invalid");
  }
  return new Date(claimedAtMilliseconds
    + DOCUMENT_PUBLICATION_ATTEMPT_MILLISECONDS).toISOString();
}

export function publicationRetryDelayMilliseconds(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw publicationDomainError("publication_attempt_invalid");
  }
  if (attempt > DOCUMENT_PUBLICATION_MAXIMUM_ATTEMPTS) {
    throw publicationDomainError("publication_attempt_limit_exceeded");
  }
  return 1_000 * 2 ** (attempt - 1);
}

function bytewise(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function publicationDomainError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Publication domain error: ${code}`), { code });
}
