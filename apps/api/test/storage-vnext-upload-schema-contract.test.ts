import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(import.meta.dirname, "../migrations/001_storage_vnext.sql"),
  "utf8"
);

describe("storage vNext upload schema contract", () => {
  it("stores normalized manifest identity without terminal payloads", () => {
    const table = tableBlock("upload_entries");
    expect(table).toMatch(/knowledge_base_id text NOT NULL/u);
    expect(table).toMatch(/source_file_public_id text NOT NULL/u);
    expect(table).toMatch(/normalized_path text NOT NULL/u);
    expect(table).toMatch(/content_type text NOT NULL/u);
    expect(table).toMatch(/UNIQUE \(upload_session_public_id, normalized_path\)/u);
    expect(table).not.toMatch(/error_(message|detail)|stack|settings_(json|snapshot)/u);
  });

  it("keeps path reservations live, scoped, expiring, and session owned", () => {
    const table = tableBlock("upload_path_reservations");
    expect(table).toMatch(/PRIMARY KEY \(knowledge_base_id, normalized_path\)/u);
    expect(table).toMatch(/upload_session_public_id text NOT NULL/u);
    expect(table).toMatch(/upload_entry_public_id text NOT NULL/u);
    expect(table).toMatch(/expires_at timestamp with time zone NOT NULL/u);
    expect(table).toMatch(/ON DELETE CASCADE/u);
  });

  it("keeps only live upload session and entry states", () => {
    expect(tableBlock("upload_sessions")).toMatch(
      /state IN \('draft', 'uploading', 'finalizing'\)/u
    );
    expect(tableBlock("upload_entries")).toMatch(
      /state IN \('pending', 'uploaded', 'verified'\)/u
    );
    expect(tableBlock("upload_sessions")).not.toMatch(
      /'completed'|'failed'|'cancelled'|'expired'|'superseded'/u
    );
  });

  it("indexes bounded expiration and reservation cleanup readers", () => {
    expect(migration).toMatch(
      /CREATE INDEX upload_sessions_expiry_idx ON focowiki\.upload_sessions \(expires_at, public_id\)/u
    );
    expect(migration).toMatch(
      /CREATE INDEX upload_path_reservations_expiry_idx ON focowiki\.upload_path_reservations \(expires_at, knowledge_base_id, normalized_path\)/u
    );
  });

  it("binds uploaded object ownership to one operation until finalization", () => {
    expect(tableBlock("object_owners")).toContain("'live_reservation'");
    expect(tableBlock("upload_sessions")).toMatch(
      /CONSTRAINT upload_sessions_operation_key UNIQUE \(operation_public_id\)/u
    );
    expect(tableBlock("upload_entries")).toMatch(
      /REFERENCES focowiki\.object_registrations \(object_id\) ON DELETE RESTRICT/u
    );
  });
});

function tableBlock(tableName: string): string {
  const match = migration.match(new RegExp(
    `CREATE TABLE focowiki\\.${tableName} \\(([\\s\\S]*?)\\n\\);`,
    "u"
  ));
  expect(match, `Missing ${tableName} table`).not.toBeNull();
  return match?.[1] ?? "";
}
