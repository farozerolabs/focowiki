import { createHash } from "node:crypto";

export type SemanticStageKind =
  | "extraction" | "embedding" | "reconciliation" | "community"
  | "vector" | "publication" | "validation" | "cleanup";

export type SemanticStageSettingsSnapshot = Readonly<Record<string, string | number | boolean | null>>;

export type SemanticStageWorkItem = {
  publicId: string;
  knowledgeBaseId: string;
  operationPublicId: string;
  semanticGenerationPublicId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  stageKind: SemanticStageKind;
  partitionKey: string;
  extractionContractVersion: string;
  embeddingConfigurationRevisionPublicId: string;
  settingsSnapshot: SemanticStageSettingsSnapshot;
  maximumAttempts: number;
};

const ORDER: readonly SemanticStageKind[] = [
  "extraction", "reconciliation", "community", "embedding",
  "vector", "publication", "validation"
];

export function planSemanticSourceStages(input: {
  knowledgeBaseId: string;
  operationPublicId: string;
  semanticGenerationPublicId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  extractionContractVersion: string;
  embeddingConfigurationRevisionPublicId: string;
  settingsSnapshot: SemanticStageSettingsSnapshot;
  dirtyCommunityPartitionKeys: readonly string[];
  includeValidation: boolean;
  includePublication?: boolean;
  resumeFromStage?: "publication";
  deletion?: boolean;
  maximumAttempts: number;
}): SemanticStageWorkItem[] {
  assertPlan(input);
  const stages: Array<{ stageKind: SemanticStageKind; partitionKey: string }> = input.deletion
    ? [
      { stageKind: "cleanup", partitionKey: input.sourceFilePublicId },
      ...unique(input.dirtyCommunityPartitionKeys).map((partitionKey) => ({
        stageKind: "community" as const, partitionKey
      })),
      { stageKind: "vector", partitionKey: input.sourceFilePublicId },
      { stageKind: "publication", partitionKey: input.sourceFilePublicId }
    ]
    : [
      { stageKind: "extraction", partitionKey: input.sourceFilePublicId },
      { stageKind: "reconciliation", partitionKey: input.sourceFilePublicId },
      ...(
        unique(input.dirtyCommunityPartitionKeys).length > 0
          ? unique(input.dirtyCommunityPartitionKeys)
          : [input.sourceFilePublicId]
      ).map((partitionKey) => ({ stageKind: "community" as const, partitionKey })),
      { stageKind: "embedding", partitionKey: input.sourceFilePublicId },
      { stageKind: "vector", partitionKey: input.sourceFilePublicId },
      ...(input.includePublication === false
        ? []
        : [{
            stageKind: "publication" as const,
            partitionKey: input.sourceFilePublicId
          }]),
      ...(input.includeValidation
        ? [{ stageKind: "validation" as const, partitionKey: input.sourceFilePublicId }]
        : [])
    ];
  const selectedStages = input.resumeFromStage === "publication"
    ? stages.filter(({ stageKind }) => (
        stageKind === "publication" || stageKind === "validation"
      ))
    : stages;
  const snapshot = Object.freeze({ ...input.settingsSnapshot });
  return selectedStages.map(({ stageKind, partitionKey }) => ({
    publicId: `semantic-stage-${hash(
      input.operationPublicId, stageKind, partitionKey,
      input.sourceRevisionPublicId
    )}`,
    knowledgeBaseId: input.knowledgeBaseId,
    operationPublicId: input.operationPublicId,
    semanticGenerationPublicId: input.semanticGenerationPublicId,
    sourceFilePublicId: input.sourceFilePublicId,
    sourceRevisionPublicId: input.sourceRevisionPublicId,
    stageKind,
    partitionKey,
    extractionContractVersion: input.extractionContractVersion,
    embeddingConfigurationRevisionPublicId:
      input.embeddingConfigurationRevisionPublicId,
    settingsSnapshot: snapshot,
    maximumAttempts: input.maximumAttempts
  }));
}

export function semanticStagePredecessors(stageKind: SemanticStageKind): SemanticStageKind[] {
  if (stageKind === "cleanup") return [];
  const index = ORDER.indexOf(stageKind);
  return index < 0 ? [] : ORDER.slice(0, index);
}

export type SemanticStageBudgetKind =
  | "generation" | "python" | "embedding"
  | "s3_read" | "s3_write" | "database_mutation"
  | "search_write" | "publication" | "maintenance";

type BudgetLimit = { concurrency: number; maximumBacklog: number };

export function createSemanticStageBudgetManager(
  limits: Record<SemanticStageBudgetKind, BudgetLimit>
) {
  const states = Object.fromEntries(Object.entries(limits).map(([kind, limit]) => {
    assertBudget(limit);
    return [kind, {
      active: 0,
      queue: [] as Array<{ knowledgeBaseId: string; resolve(release: () => void): void }>
    }];
  })) as Record<SemanticStageBudgetKind, {
    active: number;
    queue: Array<{ knowledgeBaseId: string; resolve(release: () => void): void }>;
  }>;
  const releaseFor = (kind: SemanticStageBudgetKind) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const state = states[kind];
      state.active -= 1;
      const next = state.queue.shift();
      if (next) {
        state.active += 1;
        next.resolve(releaseFor(kind));
      }
    };
  };
  return {
    acquire(kind: SemanticStageBudgetKind, knowledgeBaseId: string): Promise<() => void> {
      if (!knowledgeBaseId) return Promise.reject(budgetError("invalid_scope"));
      const state = states[kind];
      if (state.active < limits[kind].concurrency) {
        state.active += 1;
        return Promise.resolve(releaseFor(kind));
      }
      if (state.queue.length >= limits[kind].maximumBacklog) {
        return Promise.reject(budgetError("semantic_stage_backlog_full"));
      }
      return new Promise((resolve) => {
        state.queue.push({ knowledgeBaseId, resolve });
      });
    },
    stats() {
      return Object.fromEntries(Object.entries(states).map(([kind, state]) => [
        kind, { active: state.active, queued: state.queue.length }
      ])) as Record<SemanticStageBudgetKind, { active: number; queued: number }>;
    }
  };
}

function assertPlan(input: {
  knowledgeBaseId: string;
  operationPublicId: string;
  semanticGenerationPublicId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  extractionContractVersion: string;
  embeddingConfigurationRevisionPublicId: string;
  settingsSnapshot: SemanticStageSettingsSnapshot;
  maximumAttempts: number;
}): void {
  if (!input.knowledgeBaseId || !input.operationPublicId
    || !input.semanticGenerationPublicId || !input.sourceFilePublicId
    || !input.sourceRevisionPublicId || !input.extractionContractVersion
    || !input.embeddingConfigurationRevisionPublicId
    || !Number.isSafeInteger(input.maximumAttempts)
    || input.maximumAttempts < 1 || input.maximumAttempts > 100
    || Buffer.byteLength(JSON.stringify(input.settingsSnapshot)) > 32_768) {
    throw new Error("Semantic stage plan is invalid");
  }
}

function assertBudget(value: BudgetLimit): void {
  if (!Number.isSafeInteger(value.concurrency) || value.concurrency < 1
    || !Number.isSafeInteger(value.maximumBacklog) || value.maximumBacklog < 0) {
    throw new Error("Semantic stage budget is invalid");
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) =>
    left.localeCompare(right, "en"));
}

function hash(...values: string[]): string {
  return createHash("sha256").update(values.join("\u001f")).digest("hex");
}

function budgetError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Semantic stage budget error: ${code}`), { code });
}
