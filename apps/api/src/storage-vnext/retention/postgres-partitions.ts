import type { DatabaseClient } from "../../db/client.js";

export const STORAGE_VNEXT_TIME_PARTITION_FAMILIES = [
  "security_audit_events",
  "diagnostic_events"
] as const;

export type StorageVnextTimePartitionFamily =
  (typeof STORAGE_VNEXT_TIME_PARTITION_FAMILIES)[number];

export type StorageVnextPartitionWindow = {
  family: StorageVnextTimePartitionFamily;
  tableName: string;
  from: string;
  to: string;
};

export type StorageVnextPartitionRetentionInput = {
  family: StorageVnextTimePartitionFamily;
  before: Date;
  installedTableNames: readonly string[];
};

export function storageVnextPartitionWindows(
  anchor: Date
): StorageVnextPartitionWindow[] {
  assertValidDate(anchor);
  const currentMonth = utcMonthStart(anchor);
  const nextMonth = addUtcMonths(currentMonth, 1);
  const monthAfterNext = addUtcMonths(currentMonth, 2);

  return STORAGE_VNEXT_TIME_PARTITION_FAMILIES.flatMap((family) => [
    partitionWindow(family, currentMonth, nextMonth),
    partitionWindow(family, nextMonth, monthAfterNext)
  ]);
}

export function planStorageVnextPartitionRetention(
  input: StorageVnextPartitionRetentionInput
): string[] {
  assertUtcMonthBoundary(input.before);
  const cutoff = input.before.getTime();

  return input.installedTableNames
    .flatMap((tableName) => {
      const parsed = parsePartitionTableName(tableName);
      if (!parsed || parsed.family !== input.family) return [];
      const upperBound = addUtcMonths(
        new Date(Date.UTC(parsed.year, parsed.month - 1, 1)),
        1
      );
      return upperBound.getTime() <= cutoff ? [tableName] : [];
    })
    .sort();
}

export async function ensureStorageVnextTimePartitions(
  sql: DatabaseClient,
  anchor: Date
): Promise<readonly string[]> {
  const windows = storageVnextPartitionWindows(anchor);
  for (const window of windows) {
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS focowiki.${quoteIdentifier(window.tableName)} `
      + `PARTITION OF focowiki.${quoteIdentifier(window.family)} `
      + `FOR VALUES FROM ('${window.from}') TO ('${window.to}')`
    );
  }
  return windows.map((window) => window.tableName);
}

export async function pruneStorageVnextTimePartitions(
  sql: DatabaseClient,
  input: {
    family: StorageVnextTimePartitionFamily;
    before: Date;
  }
): Promise<readonly string[]> {
  const rows = await sql<Array<{ table_name: string }>>`
    SELECT child.relname AS table_name
    FROM pg_inherits inheritance
    JOIN pg_class child ON child.oid = inheritance.inhrelid
    JOIN pg_class parent ON parent.oid = inheritance.inhparent
    JOIN pg_namespace namespace ON namespace.oid = parent.relnamespace
    WHERE namespace.nspname = 'focowiki'
      AND parent.relname = ${input.family}
    ORDER BY child.relname
  `;
  const expired = planStorageVnextPartitionRetention({
    family: input.family,
    before: input.before,
    installedTableNames: rows.map((row) => row.table_name)
  });

  await sql.begin(async (transaction) => {
    for (const tableName of expired) {
      await transaction.unsafe(
        `DROP TABLE focowiki.${quoteIdentifier(tableName)}`
      );
    }
  });
  return expired;
}

function partitionWindow(
  family: StorageVnextTimePartitionFamily,
  from: Date,
  to: Date
): StorageVnextPartitionWindow {
  const year = from.getUTCFullYear().toString().padStart(4, "0");
  const month = (from.getUTCMonth() + 1).toString().padStart(2, "0");
  return {
    family,
    tableName: `${family}_${year}_${month}`,
    from: formatUtcDate(from),
    to: formatUtcDate(to)
  };
}

function parsePartitionTableName(
  tableName: string
): { family: StorageVnextTimePartitionFamily; year: number; month: number } | null {
  for (const family of STORAGE_VNEXT_TIME_PARTITION_FAMILIES) {
    const match = new RegExp(`^${family}_(\\d{4})_(\\d{2})$`, "u").exec(tableName);
    if (!match) continue;
    const year = Number.parseInt(match[1]!, 10);
    const month = Number.parseInt(match[2]!, 10);
    if (month < 1 || month > 12) return null;
    return { family, year, month };
  }
  return null;
}

function assertValidDate(value: Date): void {
  if (!Number.isFinite(value.getTime())) {
    throw new Error("Storage vNext partition anchor must be a valid UTC date.");
  }
}

function assertUtcMonthBoundary(value: Date): void {
  assertValidDate(value);
  if (
    value.getUTCDate() !== 1
    || value.getUTCHours() !== 0
    || value.getUTCMinutes() !== 0
    || value.getUTCSeconds() !== 0
    || value.getUTCMilliseconds() !== 0
  ) {
    throw new Error("Storage vNext partition retention cutoff must be a UTC month boundary.");
  }
}

function utcMonthStart(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
}

function addUtcMonths(value: Date, count: number): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + count, 1));
}

function formatUtcDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(value)) {
    throw new Error(`Invalid storage vNext partition identifier: ${value}`);
  }
  return `"${value}"`;
}
