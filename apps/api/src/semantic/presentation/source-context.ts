export type SemanticPresentedEntity = {
  label: string;
  kind: string;
  description: string | null;
  confidence: number;
  evidencePaths: readonly string[];
};

export type SemanticSourcePresentationContext = {
  entities: readonly SemanticPresentedEntity[];
};

export type SemanticSourcePresentationReadPort = {
  getSourceContext(input: {
    knowledgeBaseId: string;
    operationPublicId: string;
    sourceFilePublicId: string;
    sourceRevisionPublicId: string;
    entityLimit: number;
  }): Promise<SemanticSourcePresentationContext>;
};
