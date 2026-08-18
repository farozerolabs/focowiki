import type { DatabaseClient } from "../../db/client.js";

export async function readPostgresKnowledgeBaseSequence(
  sql: DatabaseClient,
  knowledgeBaseId: string
): Promise<number> {
  const rows = await sql<Array<{ current_sequence: number | string }>>`
    SELECT current_sequence
    FROM focowiki.knowledge_base_sequences
    WHERE knowledge_base_id = ${knowledgeBaseId}
  `;
  const sequence = Number(rows[0]?.current_sequence ?? -1);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw sequenceError("sequence_missing");
  }
  return sequence;
}

export async function allocatePostgresKnowledgeBaseSequence(input: {
  transaction: DatabaseClient;
  knowledgeBaseId: string;
  now: string;
}): Promise<number> {
  const rows = await input.transaction<Array<{
    current_sequence: number | string;
  }>>`
    INSERT INTO focowiki.knowledge_base_sequences (
      knowledge_base_id, current_sequence, updated_at
    ) VALUES (${input.knowledgeBaseId}, 1, ${input.now})
    ON CONFLICT (knowledge_base_id) DO UPDATE
    SET current_sequence = focowiki.knowledge_base_sequences.current_sequence + 1,
        updated_at = excluded.updated_at
    RETURNING current_sequence
  `;
  const sequence = Number(rows[0]?.current_sequence ?? -1);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw sequenceError("sequence_allocation_failed");
  }
  return sequence;
}

function sequenceError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Knowledge base sequence error: ${code}`), { code });
}
