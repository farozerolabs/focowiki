#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  assertPostgresCatalogComplete,
  assertValidationDatabaseTarget,
  capturePostgresCatalog
} from "./lib/comprehensive-postgres-catalog.mjs";

const databaseUrl = process.env.FOCOWIKI_COMPREHENSIVE_DATABASE_URL;
const reportDirectory = process.env.FOCOWIKI_COMPREHENSIVE_REPORT_DIR;
const apiRequire = createRequire(path.join(process.cwd(), "apps/api/package.json"));
const postgres = apiRequire("postgres");

if (!databaseUrl) throw new Error("FOCOWIKI_COMPREHENSIVE_DATABASE_URL is required");
if (
  !reportDirectory
  || !/^ReferenceDocs\/validation\/comprehensive-large-scale-release\/validation-\d{14}-[a-f0-9]{8}$/u.test(reportDirectory)
) {
  throw new Error("FOCOWIKI_COMPREHENSIVE_REPORT_DIR must be an exact ignored run-owned directory");
}

const target = assertValidationDatabaseTarget(databaseUrl);
const sql = postgres(databaseUrl, { max: 2, connect_timeout: 10, idle_timeout: 5 });
try {
  const catalog = await capturePostgresCatalog(sql);
  assertPostgresCatalogComplete(catalog);
  fs.mkdirSync(reportDirectory, { recursive: true });
  const output = path.join(reportDirectory, "postgres-runtime-catalog.json");
  fs.writeFileSync(output, `${JSON.stringify({ ...catalog, target }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output, target, cardinality: catalog.cardinality, catalogHash: catalog.catalogHash })}\n`);
} finally {
  await sql.end({ timeout: 5 });
}
