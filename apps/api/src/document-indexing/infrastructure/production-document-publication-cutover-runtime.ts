import type { DatabaseClient } from "../../db/client.js";
import { createPostgresDocumentPublicationCutover } from
  "./postgres-document-publication-cutover.js";
import { createPostgresDocumentPublicationShadowMigration } from
  "./postgres-document-publication-shadow-migration.js";
import { createPostgresDocumentPublicationShadowParity } from
  "./postgres-document-publication-shadow-parity.js";
import { createPostgresDocumentProjectionLegacyCleanup } from
  "./postgres-document-projection-legacy-cleanup.js";
import { waitForDocumentWork } from
  "./production-document-fixed-runtime-support.js";

const PAGE_LIMIT = 256;

export function createProductionDocumentPublicationCutoverRuntime(input: {
  sql: DatabaseClient;
  idlePollMilliseconds?: number;
}) {
  const shadow = createPostgresDocumentPublicationShadowMigration(input.sql);
  const parity = createPostgresDocumentPublicationShadowParity(input.sql);
  const cutover = createPostgresDocumentPublicationCutover(input.sql);
  const cleanup = createPostgresDocumentProjectionLegacyCleanup(input.sql);
  return {
    async runOne(now = new Date().toISOString()): Promise<boolean> {
      const candidate = await readNextCanary(input.sql);
      if (!candidate) return cleanup.tryCleanup(now);
      if (candidate.writerMode === "legacy") {
        await shadow.start({ knowledgeBaseId: candidate.knowledgeBaseId, now });
        return true;
      }
      if (!candidate.shadowCompleted) {
        await shadow.buildNextPage({
          knowledgeBaseId: candidate.knowledgeBaseId,
          now,
          limit: PAGE_LIMIT
        });
        return true;
      }
      if (candidate.generationState === "validating") {
        await parity.compareNextPage({
          knowledgeBaseId: candidate.knowledgeBaseId,
          now,
          limit: PAGE_LIMIT
        });
        return true;
      }
      if (candidate.generationState === "ready") {
        await cutover.cutover({
          knowledgeBaseId: candidate.knowledgeBaseId,
          now
        });
        return true;
      }
      return false;
    },

    async run(signal: AbortSignal): Promise<void> {
      while (!signal.aborted) {
        if (!await this.runOne()) {
          await waitForDocumentWork(
            input.idlePollMilliseconds ?? 100,
            signal
          );
        }
      }
    }
  };
}

async function readNextCanary(sql: DatabaseClient) {
  const rows = await sql<Array<{
    knowledge_base_id: string;
    writer_mode: "legacy" | "shadow";
    shadow_completed_at: Date | string | null;
    generation_state: string | null;
  }>>`
    SELECT knowledge_base.public_id knowledge_base_id,
           coalesce(cutover.writer_mode, 'legacy') writer_mode,
           cutover.shadow_completed_at,
           generation.state generation_state
    FROM focowiki.knowledge_bases knowledge_base
    LEFT JOIN focowiki.projection_cutover_states cutover
      ON cutover.knowledge_base_id = knowledge_base.public_id
    LEFT JOIN focowiki.projection_publication_generations generation
      ON generation.public_id = cutover.shadow_generation_public_id
    WHERE knowledge_base.deleted_at IS NULL
      AND coalesce(cutover.writer_mode, 'legacy') IN ('legacy', 'shadow')
      AND cutover.safe_error_code IS NULL
      AND (
        cutover.writer_mode = 'shadow'
        OR NOT EXISTS (
          SELECT 1 FROM focowiki.projection_publication_generations candidate
          WHERE candidate.knowledge_base_id = knowledge_base.public_id
            AND candidate.state IN (
              'planned', 'rendering', 'validating', 'ready'
            )
        )
      )
    ORDER BY CASE WHEN cutover.writer_mode = 'shadow' THEN 0 ELSE 1 END,
             (SELECT count(*) FROM focowiki.generated_page_heads page
              WHERE page.knowledge_base_id = knowledge_base.public_id),
             knowledge_base.public_id COLLATE "C"
    LIMIT 1
  `;
  const row = rows[0];
  return row ? {
    knowledgeBaseId: row.knowledge_base_id,
    writerMode: row.writer_mode,
    shadowCompleted: row.shadow_completed_at !== null,
    generationState: row.generation_state
  } : null;
}
