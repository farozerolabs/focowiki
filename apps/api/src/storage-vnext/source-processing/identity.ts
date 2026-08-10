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
  triggerOperationPublicId: string;
}): { candidatePublicId: string; candidateRootPublicId: string } {
  const value = digest([
    "source-release-candidate-v2",
    input.knowledgeBaseId,
    input.activeRootPublicId ?? "none",
    String(input.activeRevision),
    input.triggerOperationPublicId
  ]);
  return {
    candidatePublicId: `release-candidate-${value}`,
    candidateRootPublicId: `release-root-${value}`
  };
}

export function createStorageVnextPublicationWorkIdentity(input: {
  knowledgeBaseId: string;
  candidatePublicId: string;
  triggerOperationPublicId: string;
}): {
  operationPublicId: string;
  idempotency: { key: string; requestHash: string };
} {
  const identity = digest([
    "publication-operation-v2",
    input.knowledgeBaseId,
    input.candidatePublicId,
    input.triggerOperationPublicId
  ]);
  return {
    operationPublicId: `publication-operation-${identity}`,
    idempotency: {
      key: `publication-${digest([
        input.knowledgeBaseId,
        input.candidatePublicId,
        input.triggerOperationPublicId
      ])}`,
      requestHash: digest([
        "publication-request-v2",
        input.knowledgeBaseId,
        input.candidatePublicId,
        input.triggerOperationPublicId
      ])
    }
  };
}

function digest(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex");
}
