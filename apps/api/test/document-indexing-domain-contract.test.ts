import { describe, expect, it } from "vitest";
import {
  DOCUMENT_GENERATED_CONTENT_AVAILABILITIES,
  DOCUMENT_MODEL_STATUSES,
  DOCUMENT_STATES,
  isDocumentTerminalState
} from "../src/document-indexing/domain/contracts.js";

describe("document indexing domain contract", () => {
  it("uses one bounded English-only document lifecycle vocabulary", () => {
    expect(DOCUMENT_STATES).toEqual([
      "waiting",
      "processing",
      "available",
      "error",
      "deleting",
      "cancelled",
      "superseded"
    ]);
    expect(DOCUMENT_MODEL_STATUSES).toEqual([
      "not_required",
      "running",
      "completed",
      "failed"
    ]);
    expect(DOCUMENT_GENERATED_CONTENT_AVAILABILITIES).toEqual([
      "unavailable",
      "previous_available",
      "current_available"
    ]);
  });

  it("recognizes only durable document terminal states", () => {
    expect(DOCUMENT_STATES.filter(isDocumentTerminalState)).toEqual([
      "available",
      "error",
      "cancelled",
      "superseded"
    ]);
  });
});
