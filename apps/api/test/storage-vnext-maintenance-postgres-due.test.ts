import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

type Factory = (sql: unknown, options: {
  selectedSearchProviderKind: "meilisearch" | "opensearch";
}) => {
  list(input: { dueBefore: string; limit: number }): Promise<readonly {
    knowledgeBaseId: string;
    revision: number;
  }[]>;
  cancelQueuedAutomatic(input: {
    canceledAt: string;
    expiresAt: string;
    limit: number;
  }): Promise<number>;
};

let factory: Factory | undefined;

beforeAll(async () => {
  const modulePath = resolve(
    import.meta.dirname,
    "../src/storage-vnext/maintenance/postgres-due.ts"
  );
  const loaded = await import(/* @vite-ignore */ pathToFileURL(modulePath).href)
    .catch(() => ({})) as {
      createPostgresStorageVnextAutomaticMaintenanceDue?: Factory;
    };
  factory = loaded.createPostgresStorageVnextAutomaticMaintenanceDue;
});

describe("storage vNext automatic maintenance PostgreSQL due source", () => {
  it("maps a bounded due page", async () => {
    const sql = sqlFixture([
      { public_id: "kb-due-a", revision: "4" },
      { public_id: "kb-due-b", revision: 8 }
    ]);
    await expect(createDue(sql).list({
      dueBefore: "2026-08-01T00:00:00.000Z",
      limit: 20
    })).resolves.toEqual([
      { knowledgeBaseId: "kb-due-a", revision: 4 },
      { knowledgeBaseId: "kb-due-b", revision: 8 }
    ]);
    expect(sql.querySources.join("\n")).toContain(
      "AND search.provider_kind ="
    );
  });

  it("terminalizes queued automatic work in one bounded transaction", async () => {
    const sql = sqlFixture([], [{ operation_public_id: "maintenance-auto-a" }]);

    await expect(createDue(sql).cancelQueuedAutomatic({
      canceledAt: "2026-08-01T01:00:00.000Z",
      expiresAt: "2026-08-02T01:00:00.000Z",
      limit: 20
    })).resolves.toBe(1);
    expect(sql.begin).toHaveBeenCalledOnce();
  });
});

function createDue(sql: ReturnType<typeof sqlFixture>) {
  expect(factory).toBeTypeOf("function");
  if (!factory) throw new Error("Automatic maintenance due source is unavailable");
  return factory(sql, { selectedSearchProviderKind: "meilisearch" });
}

function sqlFixture(
  dueRows: readonly Record<string, unknown>[],
  canceledRows: readonly Record<string, unknown>[] = []
) {
  const querySources: string[] = [];
  const query = vi.fn(async (strings: TemplateStringsArray) => {
    const source = strings.join(" ");
    querySources.push(source);
    if (source.includes("WITH due")) return dueRows;
    if (source.includes("DELETE FROM focowiki.operation_work_items")) {
      return canceledRows;
    }
    return [];
  });
  return Object.assign(query, {
    begin: vi.fn(async (callback: (transaction: typeof query) => unknown) =>
      callback(query)),
    json: (value: unknown) => value,
    querySources
  });
}
