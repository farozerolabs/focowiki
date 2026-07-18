import type { TransactionSql } from "postgres";

export async function lockImmutableObjectKey(
  transaction: TransactionSql,
  objectKey: string
): Promise<void> {
  await transaction`
    SELECT pg_advisory_xact_lock(hashtextextended(${objectKey}, 0))
  `;
}
