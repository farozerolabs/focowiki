import { createHash } from "node:crypto";

export function createStorageVnextSourceWorkIdempotency(input: {
  knowledgeBaseId: string;
  operationPublicId: string;
  sourceRevisionPublicId: string;
}): { key: string; requestHash: string } {
  return {
    key: `source-processing-${digest([
      input.knowledgeBaseId,
      input.sourceRevisionPublicId
    ])}`,
    requestHash: digest([
      "source-processing-request-v1",
      input.knowledgeBaseId,
      input.operationPublicId,
      input.sourceRevisionPublicId
    ])
  };
}

export function createStorageVnextReleaseCandidateIdentity(input: {
  knowledgeBaseId: string;
  activeRootPublicId: string | null;
  activeRevision: number;
}): { candidatePublicId: string; candidateRootPublicId: string } {
  const value = digest([
    "source-release-candidate-v1",
    input.knowledgeBaseId,
    input.activeRootPublicId ?? "none",
    String(input.activeRevision)
  ]);
  return {
    candidatePublicId: `release-candidate-${value}`,
    candidateRootPublicId: `release-root-${value}`
  };
}

export function createStorageVnextPublicationWorkIdentity(input: {
  knowledgeBaseId: string;
  candidatePublicId: string;
}): {
  operationPublicId: string;
  idempotency: { key: string; requestHash: string };
} {
  const identity = digest([
    "publication-operation-v1",
    input.knowledgeBaseId,
    input.candidatePublicId
  ]);
  return {
    operationPublicId: `publication-operation-${identity}`,
    idempotency: {
      key: `publication-${digest([
        input.knowledgeBaseId,
        input.candidatePublicId
      ])}`,
      requestHash: digest([
        "publication-request-v1",
        input.knowledgeBaseId,
        input.candidatePublicId
      ])
    }
  };
}

function digest(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex");
}
