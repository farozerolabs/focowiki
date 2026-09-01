import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("provider-neutral retrieval migration", () => {
  it("drops only retired query-policy fields without scheduling corpus work", async () => {
    const sql = await readFile(
      new URL("../migrations/022_provider_neutral_retrieval.sql", import.meta.url),
      "utf8"
    );

    expect(sql).toContain("DROP COLUMN IF EXISTS minimum_vector_relevance");
    expect(sql).toContain(
      "DROP COLUMN IF EXISTS embedding_query_policy_revision_public_id"
    );
    expect(sql).toContain("storage-vnext-v30-provider-neutral-retrieval");
    expect(sql).not.toMatch(
      /INSERT\s+INTO\s+focowiki\.(?:document_jobs|operation_work_items|semantic_maintenance|search_outbox)/iu
    );
    expect(sql).not.toMatch(
      /UPDATE\s+focowiki\.(?:source_files|source_revisions|semantic_generations|embedding_artifacts|search_document_owners)/iu
    );
    expect(sql).not.toMatch(/DELETE\s+FROM/iu);
  });
});
