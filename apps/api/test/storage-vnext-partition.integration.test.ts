import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import {
  ensureStorageVnextTimePartitions,
  pruneStorageVnextTimePartitions
} from "../src/storage-vnext/retention/postgres-partitions.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const hasOwnedTarget = Boolean(
  databaseUrl
  && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner)
);
const describeOwnedDatabase = hasOwnedTarget ? describe : describe.skip;

describeOwnedDatabase("storage vNext PostgreSQL time partitions", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const ownerToken = (runOwner ?? "invalid").replaceAll("-", "_");
  const databaseName = `focowiki_vnext_partitions_${ownerToken}_${
    randomUUID().replaceAll("-", "").slice(0, 10)
  }`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 2 });
  const database = sql as unknown as DatabaseClient;
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    await sql.unsafe(readFileSync(
      resolve(import.meta.dirname, "../migrations/001_storage_vnext.sql"),
      "utf8"
    ));
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    if (databaseCreated) {
      await admin.unsafe(
        `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`
      );
    }
    await admin.end({ timeout: 5 });
  }, 120_000);

  it("bootstraps two range-partitioned parents with current and next month", async () => {
    const parents = await sql<Array<{ table_name: string }>>`
      SELECT relation.relname AS table_name
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'focowiki'
        AND relation.relkind = 'p'
      ORDER BY relation.relname
    `;
    const children = await installedPartitions(sql);

    expect(parents.map((row) => row.table_name)).toEqual([
      "diagnostic_events",
      "security_audit_events"
    ]);
    expect(children).toHaveLength(4);
  });

  it("creates missing monthly partitions idempotently across restart", async () => {
    const first = await ensureStorageVnextTimePartitions(
      database,
      new Date("2025-01-15T00:00:00Z")
    );
    const second = await ensureStorageVnextTimePartitions(
      database,
      new Date("2025-01-15T00:00:00Z")
    );
    const installed = await installedPartitions(sql);

    expect(second).toEqual(first);
    for (const tableName of first) expect(installed).toContain(tableName);
    expect(new Set(installed).size).toBe(installed.length);
  });

  it("routes retained events and rejects timestamps without a partition", async () => {
    await sql`
      INSERT INTO focowiki.security_audit_events
        (public_id, event_type, result, created_at, expires_at)
      VALUES ('audit-2025-01', 'settings.changed', 'success',
        '2025-01-15T00:00:00Z', '2025-02-15T00:00:00Z')
    `;
    await sql`
      INSERT INTO focowiki.diagnostic_events
        (public_id, stage, severity, event_code, created_at, expires_at)
      VALUES ('diagnostic-2025-01', 'source', 'info', 'source.completed',
        '2025-01-15T00:00:00Z', '2025-02-15T00:00:00Z')
    `;
    const routed = await sql<Array<{ table_name: string }>>`
      SELECT format('%I.%I', namespace.nspname, relation.relname) AS table_name
      FROM focowiki.security_audit_events audit
      JOIN pg_catalog.pg_class relation ON relation.oid = audit.tableoid
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE audit.public_id = 'audit-2025-01'
    `;

    expect(routed).toEqual([
      { table_name: "focowiki.security_audit_events_2025_01" }
    ]);
    await expect(sql`
      INSERT INTO focowiki.security_audit_events
        (public_id, event_type, result, created_at, expires_at)
      VALUES ('audit-unplanned', 'settings.changed', 'success',
        '2035-01-15T00:00:00Z', '2035-02-15T00:00:00Z')
    `).rejects.toMatchObject({ code: "23514" });
  });

  it("drops only complete expired partitions and can recreate them", async () => {
    const removed = await pruneStorageVnextTimePartitions(
      database,
      {
        family: "security_audit_events",
        before: new Date("2025-03-01T00:00:00Z")
      }
    );

    expect(removed).toEqual([
      "security_audit_events_2025_01",
      "security_audit_events_2025_02"
    ]);
    expect(await sql`SELECT public_id FROM focowiki.security_audit_events`).toEqual([]);

    const diagnosticRemoved = await pruneStorageVnextTimePartitions(
      database,
      {
        family: "diagnostic_events",
        before: new Date("2025-03-01T00:00:00Z")
      }
    );
    expect(diagnosticRemoved).toEqual([
      "diagnostic_events_2025_01",
      "diagnostic_events_2025_02"
    ]);

    const recreated = await ensureStorageVnextTimePartitions(
      database,
      new Date("2025-01-15T00:00:00Z")
    );
    const installed = await installedPartitions(sql);
    for (const tableName of recreated) expect(installed).toContain(tableName);
  });
});

async function installedPartitions(
  sql: ReturnType<typeof postgres>
): Promise<string[]> {
  const rows = await sql<Array<{ table_name: string }>>`
    SELECT child.relname AS table_name
    FROM pg_inherits inheritance
    JOIN pg_class child ON child.oid = inheritance.inhrelid
    JOIN pg_class parent ON parent.oid = inheritance.inhparent
    JOIN pg_namespace namespace ON namespace.oid = parent.relnamespace
    WHERE namespace.nspname = 'focowiki'
      AND parent.relname IN ('security_audit_events', 'diagnostic_events')
    ORDER BY child.relname
  `;
  return rows.map((row) => row.table_name);
}

function databaseConnectionUrl(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
