import { describe, expect, it } from "vitest";
import { createIngestionFailureFields } from
  "../src/runtime/ingestion-failure.js";

describe("ingestion failure diagnostics", () => {
  it("keeps actionable provider facts and removes credentials and payloads", () => {
    const fields = createIngestionFailureFields({
      stage: "content_projection",
      error: Object.assign(
        new Error("Embedding rejected; Authorization: Bearer embedding-secret"),
        {
          status: 429,
          request_id: "embedding-request-456",
          code: "rate_limited",
          body: "private-document-body"
        }
      ),
      errorCode: "EMBEDDING_RATE_LIMITED",
      retryable: true,
      attemptCount: 2,
      knowledgeBaseId: "knowledge-base-one",
      documentJobPublicId: "document-job-one",
      workPublicId: "document-work-one"
    });

    expect(fields).toMatchObject({
      stage: "content_projection",
      errorCode: "EMBEDDING_RATE_LIMITED",
      errorClass: "Error",
      errorMessage: "Embedding rejected; Authorization: Bearer <redacted>",
      httpStatusCode: 429,
      requestId: "embedding-request-456",
      retryable: true,
      attemptCount: 2
    });
    expect(JSON.stringify(fields)).not.toContain("embedding-secret");
    expect(JSON.stringify(fields)).not.toContain("private-document-body");
  });
});
