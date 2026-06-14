import type { DatabaseClient } from "./client.js";

export type RepositoryContext = {
  sql: DatabaseClient;
};

export function createRepositoryContext(sql: DatabaseClient): RepositoryContext {
  return { sql };
}

export async function withTransaction<T>(
  sql: DatabaseClient,
  run: (context: RepositoryContext) => Promise<T>
): Promise<T> {
  return (await sql.begin((transaction) =>
    run(createRepositoryContext(transaction as unknown as DatabaseClient))
  )) as T;
}
