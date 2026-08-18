export type DocumentJobContext = {
  publicId: string;
  knowledgeBaseId: string;
  operationPublicId: string;
  operationKind: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  runtimeSettingsRevisionPublicId: string;
  generationModelConfigurationPublicId: string | null;
  generationModelConfigurationRevision: number | null;
  embeddingConfigurationRevisionPublicId: string | null;
  semanticGenerationPublicId: string | null;
  semanticContractVersion: string;
  readinessSequence: number;
  attemptCount: number;
  maximumAttempts: number;
  acceptedAt: string;
};
