import { describe, expect, it } from "vitest";
import { readMigrationSql } from "../src/db/migrations.js";

describe("single-job publication retry recovery migration", () => {
  it("releases only nonterminal attempt metadata while workers are stopped",
    () => {
      const sql = readMigrationSql(
        "015_single_job_publication_retry_recovery.sql"
      );

      expect(sql).toContain("WHERE outcome = 'pending'");
      expect(sql).toContain("attempt_owner = NULL");
      expect(sql).toContain("attempt_token = NULL");
      expect(sql).toContain("attempt_deadline = NULL");
      expect(sql).toContain("attempt_count = 0");
      expect(sql).toContain("next_eligible_at = now()");
      expect(sql).not.toMatch(/DELETE\s+FROM\s+focowiki\.publication_/iu);
      expect(sql).not.toMatch(/UPDATE\s+focowiki\.publication_items/iu);
      expect(sql).toContain(
        "storage-vnext-v23-single-job-publication-retry-recovery"
      );
    });
});
