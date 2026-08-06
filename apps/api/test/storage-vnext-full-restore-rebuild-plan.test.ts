import { describe, expect, it } from "vitest";
import { resolveFullRestoreRebuildPlan } from
  "../src/storage-vnext/maintenance/full-restore-rebuild-plan.js";

describe("storage vNext full restore search rebuild plan", () => {
  it("reuses exactly one restored active projection and bounded runtime settings", () => {
    expect(resolveFullRestoreRebuildPlan({
      expectedKnowledgeBaseId: "knowledge-base-11111111-1111-4111-8111-111111111111",
      expectedIndexPrefix: "svnext_20260803t000000z_abcdef123456_",
      projections: [{
        knowledgeBaseId: "knowledge-base-11111111-1111-4111-8111-111111111111",
        projectionRole: "active",
        state: "ready",
        providerIndexUid: "svnext_20260803t000000z_abcdef123456_active",
        documentCount: "91234"
      }],
      sourceCount: "29736",
      graphNodeCount: "29736",
      settings: {
        search: {
          engineSearchCutoffMs: 1_000,
          indexBatchDocumentCount: 500,
          indexBatchCompressedBytes: 8 * 1_024 * 1_024,
          taskPollIntervalMs: 500,
          taskTimeoutMs: 600_000
        }
      },
      maximumSourceBytes: 10 * 1_024 * 1_024,
      pageSize: 200
    })).toEqual(expect.objectContaining({
      providerIndexUid: "svnext_20260803t000000z_abcdef123456_active",
      expectedDocumentCount: 91_234,
      sourceCount: 29_736,
      graphNodeCount: 29_736,
      pageSize: 200
    }));
  });

  it("rejects a candidate, another knowledge base, or an index outside the run prefix", () => {
    const base = {
      expectedKnowledgeBaseId: "knowledge-base-11111111-1111-4111-8111-111111111111",
      expectedIndexPrefix: "svnext_20260803t000000z_abcdef123456_",
      sourceCount: "1",
      graphNodeCount: "1",
      settings: {
        search: {
          engineSearchCutoffMs: 1_000,
          indexBatchDocumentCount: 500,
          indexBatchCompressedBytes: 8 * 1_024 * 1_024,
          taskPollIntervalMs: 500,
          taskTimeoutMs: 600_000
        }
      },
      maximumSourceBytes: 10 * 1_024 * 1_024,
      pageSize: 200
    };
    expect(() => resolveFullRestoreRebuildPlan({
      ...base,
      projections: [{
        knowledgeBaseId: base.expectedKnowledgeBaseId,
        projectionRole: "candidate",
        state: "ready",
        providerIndexUid: `${base.expectedIndexPrefix}candidate`,
        documentCount: "2"
      }]
    })).toThrow(/active projection/u);
    expect(() => resolveFullRestoreRebuildPlan({
      ...base,
      projections: [{
        knowledgeBaseId: "knowledge-base-22222222-2222-4222-8222-222222222222",
        projectionRole: "active",
        state: "ready",
        providerIndexUid: "focowiki_existing",
        documentCount: "2"
      }]
    })).toThrow(/active projection/u);
  });
});
