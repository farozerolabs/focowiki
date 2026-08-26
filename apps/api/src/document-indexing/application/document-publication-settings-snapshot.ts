import type { DocumentPublicationItem } from
  "./document-publication-job-ports.js";

export function createDocumentPublicationSettingsSnapshot(input: Readonly<{
  supplied: Readonly<Record<string, unknown>>;
  rendererContractVersion: string;
  items: readonly Readonly<DocumentPublicationItem>[];
}>): Readonly<Record<string, unknown>> {
  const identities = [
    "runtimeSettingsRevisionPublicId",
    "generationModelConfigurationPublicId",
    "embeddingConfigurationRevisionPublicId",
    "semanticGenerationPublicId",
    "semanticContractVersion"
  ] as const;
  const snapshot: Record<string, unknown> = {
    ...input.supplied,
    schemaVersion: "document-publication-settings-v1",
    rendererContractVersion: input.rendererContractVersion
  };
  for (const identity of identities) {
    const values = [...new Set(input.items.flatMap((item) => {
      const value = item.affectedEvidence[identity];
      return typeof value === "string" && value.length > 0 ? [value] : [];
    }))].sort(bytewise);
    if (values.length > 0) snapshot[`${identity}s`] = values;
  }
  const modelRevisions = [...new Set(input.items.flatMap((item) => {
    const value = item.affectedEvidence.generationModelConfigurationRevision;
    return Number.isSafeInteger(value) && Number(value) > 0
      ? [Number(value)] : [];
  }))].sort((left, right) => left - right);
  if (modelRevisions.length > 0) {
    snapshot.generationModelConfigurationRevisions = modelRevisions;
  }
  return snapshot;
}

function bytewise(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
