export type CurrentSourceRevisionContext = {
  knowledgeBaseId: string;
  sourceFileId: string;
  sourceRevisionId: string;
  revision: number;
  previousRelativePath: string | null;
  relativePath: string;
  resourceRevision: number;
  operationId: string | null;
};

export type SourceRevisionContextRepository = {
  findCurrent: (input: {
    knowledgeBaseId: string;
    sourceFileId: string;
    sourceRevisionId: string;
  }) => Promise<CurrentSourceRevisionContext | null>;
};
