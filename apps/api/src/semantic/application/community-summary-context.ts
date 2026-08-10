export type SemanticCommunitySummaryContext = {
  entities: readonly {
    publicId: string;
    label: string;
    kind: string;
    description: string | null;
  }[];
  relationships: readonly {
    publicId: string;
    sourceEntityPublicId: string;
    targetEntityPublicId: string;
    kind: string;
    description: string | null;
  }[];
};

export type SemanticCommunitySummaryContextPort = {
  load(input: {
    knowledgeBaseId: string;
    semanticGenerationPublicId: string;
    entityPublicIds: readonly string[];
    maximumEntities: number;
    maximumRelationships: number;
  }): Promise<SemanticCommunitySummaryContext>;
};
