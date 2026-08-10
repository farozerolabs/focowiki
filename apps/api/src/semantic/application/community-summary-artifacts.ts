export type SemanticCommunitySummaryArtifactIdentity = {
  knowledgeBaseId: string;
  inputSha256: string;
  modelConfigurationPublicId: string;
  modelConfigurationRevision: number;
  promptContractVersion: string;
};

export type SemanticCommunitySummaryArtifactPort = {
  find(input: SemanticCommunitySummaryArtifactIdentity): Promise<string | null>;
  put(input: SemanticCommunitySummaryArtifactIdentity & {
    summary: string;
  }): Promise<void>;
};
