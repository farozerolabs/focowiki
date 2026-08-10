import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const removedFields = [
  "generationBatchSize",
  "hardDeleteVersionPurgeEnabled",
  "graphQueryConcurrency",
  "databaseMutationConcurrency",
  "sourceQueueHardDepth",
  "sourceQueueResumeDepth",
  "sourceQueueHardAgeSeconds",
  "sourceQueueResumeAgeSeconds",
  "shutdownGraceMs",
  "failedJobRetentionDays",
  "deadLetterJobRetentionDays",
  "retentionCleanupBatchSize",
  "hardDeleteFailedRetentionDays",
  "generationAssemblyConcurrency",
  "generationRetentionDays",
  "batchSize",
  "impactBatchSize",
  "impactConcurrency",
  "projectionPartitionConcurrency",
  "directoryMaterializationConcurrency",
  "dirtyFileHardCount",
  "dirtyFileResumeCount",
  "dirtyAgeHardSeconds",
  "dirtyAgeResumeSeconds",
  "pendingImpactHardCount",
  "pendingImpactResumeCount",
  "indexShardSize",
  "linkIndexShardSize",
  "manifestShardSize",
  "graphEdgeShardSize",
  "graphCandidateLimit",
  "graphMaintenanceBatchSize",
  "rootSummaryLimit",
  "okfLogMaxEntries",
  "okfLogMaxBytes",
  "publicationShardSize",
  "cacheTtlSeconds",
  "migrationBackfillConcurrency",
  "lexicalRebuildDatabaseWriteConcurrency",
  "lexicalRebuildClaimBatchSize",
  "lexicalRebuildDatabaseBatchSize",
  "scanIntervalSeconds",
  "confirmationPasses",
  "compactionConcurrency",
  "branchCandidateLimit",
  "fusedCandidateLimit",
  "graphSeedLimit",
  "graphNeighborLimit",
  "engineQueueLatencyLimitMs",
  "engineResidentMemoryLimitBytes",
  "engineDatabaseSizeLimitBytes",
  "engineTaskQueueSizeLimitBytes"
] as const;

const retainedFields = [
  "sourceObjectReadConcurrency",
  "generatedObjectWriteConcurrency",
  "reconciliationEnabled",
  "stagingRetentionHours",
  "projectionRepairConcurrency",
  "projectionRepairDatabaseBatchSize",
  "projectionRepairObjectWriteConcurrency",
  "lexicalRebuildConcurrency",
  "lexicalRebuildSourceReadConcurrency",
  "lexicalRebuildMaxInFlightSourceBytes"
] as const;

const adminRemovedFields = removedFields.filter((field) => field !== "batchSize");

const apiSourceRoot = resolve(import.meta.dirname, "../src");
const removedFieldValidator = resolve(
  apiSourceRoot,
  "runtime-settings/candidate-validation.ts"
);
const adminSettingsPanel = resolve(
  import.meta.dirname,
  "../../admin/src/components/settings-panel.tsx"
);

describe("storage vNext removed runtime-setting fields", () => {
  it("keeps removed names out of the live runtime-settings boundary", () => {
    const rejectionSource = readFileSync(removedFieldValidator, "utf8");
    const liveSettingsSource = [
      "runtime-settings/types.ts",
      "runtime-settings/validation.ts",
      "runtime-settings/service.ts",
      "runtime-settings/resource-capacity-validation.ts",
      "runtime-settings/resource-budget-settings.ts"
    ].map((relativePath) => readFileSync(resolve(apiSourceRoot, relativePath), "utf8"))
      .join("\n");

    for (const field of removedFields) {
      expect(
        liveSettingsSource,
        `${field} still has a live runtime-settings definition or reader`
      ).not.toContain(field);
      expect(countOccurrences(rejectionSource, field), `${field} rejection count`)
        .toBe(field === "cacheTtlSeconds" ? 2 : 1);
    }
  });

  it("freezes the bilingual product copy after the approved semantic additions", () => {
    const resources = readFileSync(resolve(
      import.meta.dirname,
      "../../admin/src/i18n/resources.ts"
    ));
    expect(createHash("sha256").update(resources).digest("hex")).toBe(
      "7e29212345d2fadd2a57ad4e92c0fa36b07d5dbfc78a8f7b2ceff5c0885b6ee9"
    );
  });

  it("removes only the approved fields from the existing Admin settings boundary", () => {
    for (const relativePath of [
      "../../admin/src/lib/admin-api.ts",
      "../../admin/src/components/settings-panel.tsx"
    ]) {
      const source = readFileSync(resolve(import.meta.dirname, relativePath), "utf8");
      for (const field of adminRemovedFields) {
        expect(source, `${relativePath} still exposes ${field}`).not.toContain(field);
      }
      for (const field of retainedFields) {
        expect(source, `${relativePath} no longer exposes retained ${field}`).toContain(field);
      }
    }
  });

  it("keeps the retained maintenance fields on storage-vNext runtime readers", () => {
    const runtimeTypes = readFileSync(resolve(
      apiSourceRoot,
      "runtime-settings/types.ts"
    ), "utf8");
    const runtimeValidation = readFileSync(resolve(
      apiSourceRoot,
      "runtime-settings/validation.ts"
    ), "utf8");
    const productionPipeline = readFileSync(resolve(
      apiSourceRoot,
      "storage-vnext/publication/production-pipeline.ts"
    ), "utf8");
    const maintenanceRuntime = readFileSync(resolve(
      apiSourceRoot,
      "storage-vnext/maintenance/production-runtime.ts"
    ), "utf8");
    const resourceBudgetSettings = readFileSync(resolve(
      apiSourceRoot,
      "runtime-settings/resource-budget-settings.ts"
    ), "utf8");

    for (const field of retainedFields) {
      expect(runtimeTypes, `${field} is missing from runtime types`).toContain(field);
      expect(runtimeValidation, `${field} is missing from runtime validation`).toContain(field);
      expect(
        `${productionPipeline}\n${maintenanceRuntime}\n${resourceBudgetSettings}`,
        `${field} has no storage-vNext runtime reader`
      ).toContain(field);
    }
  });

  it("freezes the released settings UI shell outside approved field-level changes", () => {
    const source = readFileSync(adminSettingsPanel, "utf8");
    const uiImports = collectImportStatements(source)
      .filter((statement) => statement.includes('from "@/components/ui/'));
    const importedComponents = new Set(uiImports.flatMap((statement) => {
      const match = statement.match(/import\s+\{([\s\S]*?)\}\s+from/);
      return match?.[1]?.split(",").map((name) => name.trim()).filter(Boolean) ?? [];
    }));
    const sharedComponentSequence = [...source.matchAll(/<\/?([A-Z][A-Za-z0-9]*)\b/g)]
      .map((match) => match[1] ?? "")
      .filter((name) => importedComponents.has(name));
    const classNames = [...source.matchAll(/className="([^"]+)"/g)]
      .map((match) => match[1] ?? "");
    const iconSequence = [...source.matchAll(/<([A-Z][A-Za-z0-9]*Icon)\b/g)]
      .map((match) => match[1] ?? "");
    const tabs = [...source.matchAll(/<TabsTrigger value="([^"]+)"/g)]
      .map((match) => match[1] ?? "");

    expect(tabs).toEqual([
      "rate-limits",
      "worker",
      "publication",
      "graph",
      "maintenance",
      "search",
      "semantic",
      "embeddings",
      "rerankers",
      "models"
    ]);
    expect.soft(sha256(uiImports.join("\n")), "shared UI imports").toBe(
      "a7fb588e9e7f4d6b611ee09a185e913dd8bdd97eb8420da03efcc04c2a20e906"
    );
    expect.soft(
      sha256(sharedComponentSequence.join("\n")),
      "shared component hierarchy"
    ).toBe("a9cb91cf86e66afcdaab867952bfc163b5ceba3bdab604c40659006c9922135a");
    expect.soft(sha256(classNames.join("\n")), "CSS and style tokens").toBe(
      "83a5400f03551be94aee98dbd8addc7c9c0a85281fdccd97e734de6bed159992"
    );
    expect.soft(sha256(iconSequence.join("\n")), "icon sequence").toBe(
      "47365cb1a6777969c7144343ae4a62596f3db570f9b97fc652ffb8f275625707"
    );
    expect([...source.matchAll(/<Dialog(?:\s|>)/g)]).toHaveLength(1);
    expect([...source.matchAll(/<AlertDialog(?:\s|>)/g)]).toHaveLength(1);
    expect(source).not.toMatch(/\b(?:setInterval|setTimeout|clearInterval|clearTimeout)\b/);
  });
});

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function collectImportStatements(source: string): string[] {
  const statements: string[] = [];
  let current = "";

  for (const line of source.split("\n")) {
    if (!current && !line.startsWith("import ")) continue;
    current = current ? `${current}\n${line}` : line;
    if (!line.endsWith(";")) continue;
    statements.push(current);
    current = "";
  }

  return statements;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
