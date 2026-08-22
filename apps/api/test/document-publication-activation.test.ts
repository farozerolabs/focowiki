import { describe, expect, it } from "vitest";
import {
  documentPublicationActivationLockOrder,
  documentPublicationContentionDecision,
  encodeCompositeOwnerKey,
  planDocumentPublicationActivationReservations
} from "../src/document-indexing/application/document-publication-activation.js";

describe("document publication activation", () => {
  it("uses one canonical bytewise lock order for every owner family", () => {
    expect(documentPublicationActivationLockOrder({
      sourceFilePublicIds: ["z", "a"],
      relationPublicIds: ["r2", "r1"],
      searchOwnerKeys: ["s2", "s1"],
      normalizedPaths: ["pages/z.md", "index.md"],
      directoryPaths: ["pages/z", "pages"],
      documentJobPublicIds: ["job-2", "job-1"],
      receiptPublicIds: ["receipt-2", "receipt-1"],
      outboxPublicIds: ["outbox-2", "outbox-1"]
    }).map((item) => `${item.family}:${item.key}`)).toEqual([
      "source:a", "source:z", "relation:r1", "relation:r2",
      "search:s1", "search:s2", "page:index.md", "page:pages/z.md",
      "directory:pages", "directory:pages/z", "job:job-1", "job:job-2",
      "receipt:receipt-1", "receipt:receipt-2",
      "outbox:outbox-1", "outbox:outbox-2"
    ]);
  });

  it("reserves every mutable activation owner during generation planning", () => {
    expect(planDocumentPublicationActivationReservations({
      documents: [{
        documentJobPublicId: "job-1",
        sourceFilePublicId: "source-1",
        relatedSourceFilePublicIds: ["source-2"]
      }],
      putPaths: ["pages/a.md", "index.md"],
      deletePaths: ["pages/old.md"],
      searchSourceFilePublicIds: ["source-1", "source-2"],
      directoryPaths: ["pages", "_index"]
    })).toEqual(expect.arrayContaining([
      { family: "source", key: "source-1" },
      { family: "relation", key: "8:source-18:source-2" },
      { family: "search", key: "source-2" },
      { family: "page", key: "pages/old.md" },
      { family: "directory", key: "_index" },
      { family: "job", key: "job-1" },
      { family: "receipt", key: "job-1:activation:visible" },
      { family: "outbox", key: "job-1:projection-cleanup" }
    ]));
  });

  it("reserves source owners without fake job owners for deletion facts", () => {
    const reservations = planDocumentPublicationActivationReservations({
      documents: [{
        documentJobPublicId: null,
        sourceFilePublicId: "source-deleted",
        relatedSourceFilePublicIds: []
      }],
      putPaths: [],
      deletePaths: ["pages/deleted.md"],
      searchSourceFilePublicIds: ["source-deleted"],
      directoryPaths: ["pages"]
    });
    expect(reservations).toContainEqual({
      family: "source", key: "source-deleted"
    });
    expect(reservations.some((item) => ["job", "receipt", "outbox"]
      .includes(item.family))).toBe(false);
  });

  it("encodes composite owner keys without forbidden or ambiguous delimiters", () => {
    expect(encodeCompositeOwnerKey(["a:b", "c"])).toBe("3:a:b1:c");
    expect(encodeCompositeOwnerKey(["a", "b:c"])).toBe("1:a3:b:c");
    expect(encodeCompositeOwnerKey(["a:b", "c"]))
      .not.toBe(encodeCompositeOwnerKey(["a", "b:c"]));
    expect(encodeCompositeOwnerKey(["source-1", "source-2"]))
      .not.toContain("\0");
  });

  it("retries only bounded short-transaction contention with full jitter", () => {
    expect(documentPublicationContentionDecision({
      code: "40P01", attempt: 2, maximumAttempts: 4, random: 0.5
    })).toEqual({ action: "retry", delayMilliseconds: 25,
      consumesBusinessAttempt: false });
    expect(documentPublicationContentionDecision({
      code: "55P03", attempt: 4, maximumAttempts: 4, random: 0.5
    })).toEqual({ action: "defer", delayMilliseconds: 0,
      consumesBusinessAttempt: false });
    expect(documentPublicationContentionDecision({
      code: "23505", attempt: 1, maximumAttempts: 4, random: 0.5
    })).toEqual({ action: "fail", delayMilliseconds: 0,
      consumesBusinessAttempt: true });
  });
});
