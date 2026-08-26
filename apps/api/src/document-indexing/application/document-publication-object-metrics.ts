export type DocumentPublicationObjectMetrics = Readonly<{
  objectPutCount: number;
  objectReuseCount: number;
  objectRequestCount: number;
  objectAttemptedBytes: number;
  peakActiveScopeCount: number;
}>;

export function selectDocumentPublicationObjectMetrics(
  input: DocumentPublicationObjectMetrics
): DocumentPublicationObjectMetrics {
  return {
    objectPutCount: input.objectPutCount,
    objectReuseCount: input.objectReuseCount,
    objectRequestCount: input.objectRequestCount,
    objectAttemptedBytes: input.objectAttemptedBytes,
    peakActiveScopeCount: input.peakActiveScopeCount
  };
}
