import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const adminApi = read("../../admin/src/lib/admin-api.ts");
const settingsPanel = read("../../admin/src/components/settings-panel.tsx");
const settingsRoutes = read("../src/admin/runtime-settings-routes.ts");

describe("document indexing runtime settings boundary", () => {
  it("removes the publication object, tab, mode, and mutation endpoint", () => {
    expect(adminApi).not.toContain("PublicationSettings");
    expect(adminApi).not.toContain("updatePublicationSettings");
    expect(adminApi).not.toContain("/admin/api/settings/publication");
    expect(settingsPanel).not.toContain('value="publication"');
    expect(settingsPanel).not.toContain("publicationModes");
    expect(settingsPanel).not.toContain("generatedObjectWriteConcurrency");
    expect(settingsRoutes).not.toContain('"/admin/api/settings/publication"');
  });

  it("exposes only actionable worker controls", () => {
    for (const field of [
      "sourceFileConcurrency",
      "s3Concurrency",
      "jobMaxAttempts",
      "jobRetryDelayMs",
      "completedJobRetentionDays"
    ]) {
      expect(adminApi).toContain(field);
      expect(settingsPanel).toContain(field);
      expect(settingsRoutes).toContain(field);
    }
    for (const field of [
      "sourceObjectReadConcurrency",
      "claimBatchSize",
      "pollIntervalMs",
      "lockTtlSeconds",
      "heartbeatIntervalMs"
    ]) {
      expect(adminApi).not.toContain(field);
      expect(settingsPanel).not.toContain(field);
    }
    expect(settingsRoutes).toContain("sourceObjectReadConcurrency");
  });

  it("keeps generated directory limits in a non-publication section", () => {
    expect(adminApi).toContain("GeneratedSettings");
    expect(adminApi).toContain("updateGeneratedSettings");
    expect(settingsRoutes).toContain('"/admin/api/settings/generated"');
    expect(settingsPanel).toContain('value="generated"');
    expect(settingsPanel).toContain('id={`generated-${field}`}');
    expect(settingsPanel).toContain('"directoryIndexMaxEntries"');
    expect(settingsPanel).toContain('"directoryIndexMaxBytes"');
  });

  it("keeps the existing settings layout and shared UI components", () => {
    expect(settingsPanel).toContain('className="grid gap-4 md:grid-cols-2 xl:grid-cols-3"');
    expect(settingsPanel).toContain("<TabsList>");
    expect(settingsPanel).toContain("<SettingsCard");
    expect(settingsPanel).toContain("<NumberField");
    expect(settingsPanel).toContain("<SaveButton");
    expect([...settingsPanel.matchAll(/<Dialog(?:\s|>)/g)]).toHaveLength(1);
    expect([...settingsPanel.matchAll(/<AlertDialog(?:\s|>)/g)]).toHaveLength(1);
  });
});

function read(relativePath: string): string {
  return readFileSync(resolve(import.meta.dirname, relativePath), "utf8");
}
