import { createHash } from "node:crypto";
import type { SemanticCommunitySummaryContextPort } from
  "./community-summary-context.js";
import type { SemanticCommunitySummaryArtifactPort } from
  "./community-summary-artifacts.js";
import type { SemanticStageWorkClaim } from "./stage-ports.js";
import type { GraphRagModelCompletionPort } from
  "../graphrag/extraction-gateway.js";

export function createSemanticCommunitySummarizer(input: {
  contexts: SemanticCommunitySummaryContextPort;
  artifacts: SemanticCommunitySummaryArtifactPort;
  resolveCompletion(
    stageClaim: SemanticStageWorkClaim
  ): Promise<GraphRagModelCompletionPort>;
}) {
  return async function summarize(request: {
    stageClaim: SemanticStageWorkClaim;
    knowledgeBaseId: string;
    semanticGenerationPublicId: string;
    partitionKey: string;
    entityPublicIds: readonly string[];
    signal: AbortSignal;
  }): Promise<string> {
    const maximumSummaryCharacters = snapshotInteger(
      request.stageClaim,
      "maximumCommunitySummaryCharacters",
      1,
      65_536
    );
    const context = await input.contexts.load({
      knowledgeBaseId: request.knowledgeBaseId,
      semanticGenerationPublicId: request.semanticGenerationPublicId,
      entityPublicIds: request.entityPublicIds,
      maximumEntities: 100,
      maximumRelationships: 1_000
    });
    if (request.signal.aborted) {
      throw request.signal.reason
        ?? new DOMException("Semantic community summary aborted", "AbortError");
    }
    if (context.entities.length === 1) {
      const entity = context.entities[0]!;
      const sourceGroundedSummary = entity.description?.trim() || entity.label.trim();
      return sourceGroundedSummary.slice(0, maximumSummaryCharacters);
    }
    const prompt = renderPrompt(request.partitionKey, context);
    if (Buffer.byteLength(prompt) > 128_000) {
      throw summaryError("semantic_community_prompt_limit", false);
    }
    const identity = {
      knowledgeBaseId: request.knowledgeBaseId,
      inputSha256: createHash("sha256").update(prompt).digest("hex"),
      modelConfigurationPublicId: snapshotString(
        request.stageClaim,
        "generationModelConfigurationPublicId"
      ),
      modelConfigurationRevision: snapshotInteger(
        request.stageClaim,
        "generationModelConfigurationRevision",
        1,
        Number.MAX_SAFE_INTEGER
      ),
      promptContractVersion: snapshotString(
        request.stageClaim,
        "promptContractVersion"
      )
    };
    const cached = await input.artifacts.find(identity);
    if (cached !== null) {
      if (!cached.trim() || cached.length > maximumSummaryCharacters) {
        throw summaryError("semantic_community_summary_artifact_invalid", false);
      }
      return cached.trim();
    }
    const completion = await input.resolveCompletion(request.stageClaim);
    const summary = (await completion.complete({
      prompt,
      signal: request.signal
    })).trim();
    if (!summary || summary.length > maximumSummaryCharacters) {
      throw summaryError("semantic_community_summary_invalid", false);
    }
    await input.artifacts.put({ ...identity, summary });
    return summary;
  };
}

function snapshotString(
  claim: SemanticStageWorkClaim,
  key: string
): string {
  const value = claim.settingsSnapshot[key];
  if (typeof value !== "string" || !value || value.length > 255) {
    throw summaryError("semantic_settings_snapshot_invalid", false);
  }
  return value;
}

function renderPrompt(
  partitionKey: string,
  context: Awaited<ReturnType<SemanticCommunitySummaryContextPort["load"]>>
): string {
  const entities = context.entities.map((entity) => ({
    id: entity.publicId,
    label: entity.label,
    kind: entity.kind,
    description: entity.description
  }));
  const relationships = context.relationships.map((relationship) => ({
    source: relationship.sourceEntityPublicId,
    target: relationship.targetEntityPublicId,
    kind: relationship.kind,
    description: relationship.description
  }));
  return [
    "Summarize the connected concept group using only the supplied facts.",
    "Do not invent facts. Explain the shared theme and important relationships in plain language.",
    `Partition: ${partitionKey}`,
    `Entities: ${JSON.stringify(entities)}`,
    `Relationships: ${JSON.stringify(relationships)}`
  ].join("\n");
}

function snapshotInteger(
  claim: SemanticStageWorkClaim,
  key: string,
  minimum: number,
  maximum: number
): number {
  const value = claim.settingsSnapshot[key];
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw summaryError("semantic_settings_snapshot_invalid", false);
  }
  return Number(value);
}

function summaryError(code: string, retryable: boolean): Error & {
  code: string;
  retryable: boolean;
} {
  return Object.assign(new Error(`Semantic community summary failed: ${code}`), {
    code,
    retryable
  });
}
