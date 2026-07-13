export type UploadSessionStoragePort = {
  putEntry: (input: {
    knowledgeBaseId: string;
    sessionId: string;
    entryId: string;
    bytes: Uint8Array;
  }) => Promise<{ objectKey: string }>;
  deleteObject: (objectKey: string) => Promise<void>;
  deleteObjects: (objectKeys: string[]) => Promise<void>;
};

export type UploadSessionFinalizationPort = {
  enqueue: (input: {
    knowledgeBaseId: string;
    sessionId: string;
  }) => Promise<void>;
};
