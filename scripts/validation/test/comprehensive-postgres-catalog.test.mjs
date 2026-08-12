import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPostgresCatalogComplete,
  assertValidationDatabaseTarget
} from "../lib/comprehensive-postgres-catalog.mjs";

test("rejects PostgreSQL catalog targets without a validation-owned database", () => {
  assert.throws(
    () => assertValidationDatabaseTarget("postgres://user:password@127.0.0.1:5432/focowiki"),
    /validation-owned database/u
  );
  assert.deepEqual(
    assertValidationDatabaseTarget("postgres://user:password@127.0.0.1:5432/focowiki_clr_catalog"),
    { host: "127.0.0.1", port: "5432", databaseName: "focowiki_clr_catalog" }
  );
});

test("rejects incomplete or incompatible PostgreSQL runtime catalogs", () => {
  const complete = {
    schemaGeneration: "storage-vnext-v3-semantic",
    tables: [{ table_name: "runtime_generation" }],
    columns: [{ table_name: "runtime_generation" }],
    constraints: [{ table_name: "runtime_generation" }],
    indexes: [{ table_name: "runtime_generation" }]
  };
  assert.doesNotThrow(() => assertPostgresCatalogComplete(complete));
  assert.throws(
    () => assertPostgresCatalogComplete({ ...complete, columns: [] }),
    /missing columns/u
  );
  assert.throws(
    () => assertPostgresCatalogComplete({ ...complete, schemaGeneration: "stale" }),
    /Unexpected PostgreSQL schema generation/u
  );
  assert.throws(
    () => assertPostgresCatalogComplete({
      ...complete,
      indexes: [{ table_name: "unowned" }]
    }),
    /no owned table/u
  );
});
