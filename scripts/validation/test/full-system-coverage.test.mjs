import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  ADMIN_API_ROUTE_FAMILIES,
  ADMIN_UI_FLOWS,
  EXPECTED_DEVELOPER_OPENAPI_OPERATIONS,
  GENERATED_OUTPUT_FAMILIES,
  RUNTIME_SETTINGS_GROUPS,
  WORKER_JOB_KINDS,
  buildFullSystemCoverageManifest
} from "../lib/full-system-coverage.mjs";

const currentOpenApi = JSON.parse(
  fs.readFileSync("docs/public/openapi/focowiki-openapi.json", "utf8")
);

test("maps every current Developer OpenAPI operation exactly once", () => {
  const manifest = buildFullSystemCoverageManifest({ openApiDocument: currentOpenApi });

  assert.equal(manifest.developerOpenApi.actualCount, 43);
  assert.deepEqual(manifest.developerOpenApi.unmapped, []);
  assert.deepEqual(manifest.developerOpenApi.stale, []);
  assert.deepEqual(manifest.developerOpenApi.duplicates, []);
  assert.deepEqual(
    manifest.developerOpenApi.operationIds,
    [...EXPECTED_DEVELOPER_OPENAPI_OPERATIONS].sort()
  );
});

test("fails coverage when OpenAPI adds an unmapped operation", () => {
  const changed = structuredClone(currentOpenApi);
  changed.paths["/openapi/v2/unmapped"] = {
    get: { operationId: "unmappedOperation", responses: { 200: { description: "ok" } } }
  };

  assert.throws(
    () => buildFullSystemCoverageManifest({ openApiDocument: changed }),
    /unmappedOperation/
  );
});

test("keeps explicit complete inventories for non-OpenAPI surfaces", () => {
  assert.ok(ADMIN_UI_FLOWS.length >= 20);
  assert.ok(ADMIN_API_ROUTE_FAMILIES.length >= 10);
  assert.deepEqual(WORKER_JOB_KINDS.sort(), [
    "hard_delete",
    "publication",
    "resource_operation",
    "source_file_processing",
    "upload_session_finalization"
  ]);
  assert.ok(RUNTIME_SETTINGS_GROUPS.includes("models"));
  assert.ok(RUNTIME_SETTINGS_GROUPS.includes("graph"));
  assert.ok(GENERATED_OUTPUT_FAMILIES.includes("nested-navigation"));
  assert.ok(GENERATED_OUTPUT_FAMILIES.includes("graph-shards"));
});
