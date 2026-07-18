export type UploadSessionStoragePort = {
  putEntry: (input: {
    knowledgeBaseId: string;
    sessionId: string;
    entryId: string;
    body: ReadableStream<Uint8Array>;
    declaredSize: number;
  }) => Promise<{
    objectKey: string;
    receivedSize: number;
    receivedChecksumSha256: string;
  }>;
  deleteObject: (objectKey: string) => Promise<void>;
  deleteObjects: (objectKeys: string[]) => Promise<void>;
};
