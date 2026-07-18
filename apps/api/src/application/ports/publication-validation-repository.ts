export type PublicationValidationIssue = {
  code: string;
  message: string;
  reference: string | null;
};

export interface PublicationValidationRepository {
  validateChangedClosure(input: {
    knowledgeBaseId: string;
    generationId: string;
    issueLimit: number;
  }): Promise<PublicationValidationIssue[]>;
}
