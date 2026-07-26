import assert from "node:assert/strict";
import test from "node:test";
import {
  RUNTIME_SETTINGS_BOUNDARY_CATEGORIES
} from "../lib/runtime-settings-boundary-categories.mjs";

test("covers every persisted runtime settings category", () => {
  assert.deepEqual(
    RUNTIME_SETTINGS_BOUNDARY_CATEGORIES,
    [
      ["rateLimits", "/admin/api/settings/rate-limits"],
      ["worker", "/admin/api/settings/worker"],
      ["publication", "/admin/api/settings/publication"],
      ["graph", "/admin/api/settings/graph"],
      ["maintenance", "/admin/api/settings/maintenance"]
    ]
  );
});
