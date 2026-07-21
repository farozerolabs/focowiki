export type PublicationActivationContext = {
  state: "building" | "validating" | "active" | "failed" | "superseded";
  predecessorGenerationId: string | null;
};

export interface PublicationActivationStateRepository {
  getActivationContext(input: {
    knowledgeBaseId: string;
    generationId: string;
  }): Promise<PublicationActivationContext | null>;
}
