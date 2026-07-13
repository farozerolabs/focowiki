import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresGeneratedOutputResetRepository } from "../src/infrastructure/postgres/generated-output-reset-repository.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("generated output reset repository integration", () => {
  const sql = postgres(databaseUrl!, { max: 3 });
  const repository = createPostgresGeneratedOutputResetRepository(sql);
  const knowledgeBaseId = "kb-generated-reset-repository";
  const prefix = "generated/reset-repository/release/";

  beforeEach(async () => {
    await cleanup();
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES (${knowledgeBaseId}, 'Generated reset repository')
    `;
    await sql`
      INSERT INTO focowiki.generated_output_resets (knowledge_base_id)
      VALUES (${knowledgeBaseId})
    `;
    await sql`
      INSERT INTO focowiki.generated_output_reset_prefixes (knowledge_base_id, prefix)
      VALUES (${knowledgeBaseId}, ${prefix})
    `;
  });

  afterAll(async () => {
    await cleanup();
    await sql.end({ timeout: 5 });
  });

  it("completes one reset and enqueues exactly one idempotent rebuild", async () => {
    const startedAt = "2026-07-13T00:00:00.000Z";
    const completedAt = "2026-07-13T00:01:00.000Z";

    await expect(repository.beginReset({ knowledgeBaseId, startedAt })).resolves.toBe("running");
    await expect(repository.listPendingPrefixes({ knowledgeBaseId, limit: 25 }))
      .resolves.toEqual([prefix]);
    await repository.markPrefixDeleted({ knowledgeBaseId, prefix, deletedAt: completedAt });
    await repository.completeResetAndEnqueueRebuild({
      knowledgeBaseId,
      completedAt,
      publicationJobMaxAttempts: 3
    });
    await repository.completeResetAndEnqueueRebuild({
      knowledgeBaseId,
      completedAt,
      publicationJobMaxAttempts: 3
    });

    await expect(repository.isResetPending({ knowledgeBaseId })).resolves.toBe(false);
    const jobs = await sql<Array<{ kind: string; status: string; count: number }>>`
      SELECT kind, status, count(*)::integer AS count
      FROM focowiki.worker_jobs
      WHERE knowledge_base_id = ${knowledgeBaseId}
      GROUP BY kind, status
    `;
    expect(jobs).toEqual([{ kind: "publication", status: "queued", count: 1 }]);
  });

  async function cleanup(): Promise<void> {
    await sql`
      DELETE FROM focowiki.worker_jobs
      WHERE knowledge_base_id = ${knowledgeBaseId}
    `;
    await sql`
      DELETE FROM focowiki.generated_output_resets
      WHERE knowledge_base_id = ${knowledgeBaseId}
    `;
    await sql`
      DELETE FROM focowiki.knowledge_bases
      WHERE id = ${knowledgeBaseId}
    `;
  }
});
