import { describe, expect, it } from "vitest";
import { createDocumentPublicationRuntimeFailureReporter } from
  "../src/document-indexing/application/document-publication-runtime-failure-reporter.js";

describe("document publication runtime failure reporter", () => {
  it("emits the first failure, aggregates repeats, and reports recovery", () => {
    let now = 1_000;
    const events: unknown[] = [];
    const reporter = createDocumentPublicationRuntimeFailureReporter({
      now: () => now,
      reportIntervalMs: 30_000,
      emit: (event) => events.push(event)
    });

    reporter.failed("database_unavailable");
    reporter.failed("database_unavailable");
    now += 29_999;
    reporter.failed("database_unavailable");
    expect(events).toEqual([{
      event: "failed",
      errorCode: "database_unavailable",
      failureCount: 1,
      suppressedFailureCount: 0,
      durationMs: 0
    }]);

    now += 1;
    reporter.failed("database_unavailable");
    reporter.recovered();

    expect(events).toEqual([
      {
        event: "failed",
        errorCode: "database_unavailable",
        failureCount: 1,
        suppressedFailureCount: 0,
        durationMs: 0
      },
      {
        event: "failed",
        errorCode: "database_unavailable",
        failureCount: 4,
        suppressedFailureCount: 2,
        durationMs: 30_000
      },
      {
        event: "recovered",
        errorCode: "database_unavailable",
        failureCount: 4,
        suppressedFailureCount: 0,
        durationMs: 30_000
      }
    ]);
  });

  it("reports a changed error code immediately", () => {
    const events: unknown[] = [];
    const reporter = createDocumentPublicationRuntimeFailureReporter({
      now: () => 1_000,
      reportIntervalMs: 30_000,
      emit: (event) => events.push(event)
    });

    reporter.failed("database_unavailable");
    reporter.failed("publication_claim_failed");

    expect(events).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({
      event: "failed",
      errorCode: "publication_claim_failed",
      failureCount: 1
    });
  });
});
