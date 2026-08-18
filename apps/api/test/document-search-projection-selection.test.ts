import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import type { DocumentJobContext } from
  "../src/document-indexing/application/document-job-context.js";
import {
  preferMaintenanceSearchProjection,
  readSearchProjection
} from "../src/document-indexing/infrastructure/production-document-processor-support.js";

describe("document search projection selection", () => {
  it("prefers a preparing projection while allowing the active maintenance fallback", async () => {
    const query = vi.fn(async (..._args: unknown[]) => [{
      public_id: "search-projection-target",
      provider_index_uid: "focowiki_target",
      schema_checksum_sha256: "a".repeat(64)
    }]);
    const job = {
      operationKind: "maintenance"
    } as DocumentJobContext;

    const result = await readSearchProjection(query as unknown as DatabaseClient, {
      knowledgeBaseId: "knowledge-base-one",
      providerKind: "opensearch",
      preferPreparing: preferMaintenanceSearchProjection(job)
    });

    expect(result.publicId).toBe("search-projection-target");
    expect(query.mock.calls[0]!.slice(1)).toContain(true);
    expect(String(query.mock.calls[0]![0]).replace(/\s+/gu, " "))
      .toContain("state = 'active' OR");
  });

  it("does not accept an arbitrary projection pin for normal jobs", () => {
    const job = {
      operationKind: "upload"
    } as DocumentJobContext;

    expect(preferMaintenanceSearchProjection(job)).toBe(false);
  });
});
