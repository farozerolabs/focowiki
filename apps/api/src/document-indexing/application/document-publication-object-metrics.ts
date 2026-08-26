export type DocumentPublicationObjectMetrics = Readonly<{
  objectPutCount: number;
  objectReuseCount: number;
  objectRequestCount: number;
  objectAttemptedBytes: number;
  peakActiveScopeCount: number;
  outputCount: number;
  navigationMutationCount: number;
  navigationLeafCount: number;
  navigationEntryCount: number;
  maximumNavigationMutationBytes: number;
}>;

export function selectDocumentPublicationObjectMetrics(
  input: DocumentPublicationObjectMetrics
): DocumentPublicationObjectMetrics {
  return {
    objectPutCount: input.objectPutCount,
    objectReuseCount: input.objectReuseCount,
    objectRequestCount: input.objectRequestCount,
    objectAttemptedBytes: input.objectAttemptedBytes,
    peakActiveScopeCount: input.peakActiveScopeCount,
    outputCount: input.outputCount,
    navigationMutationCount: input.navigationMutationCount,
    navigationLeafCount: input.navigationLeafCount,
    navigationEntryCount: input.navigationEntryCount,
    maximumNavigationMutationBytes: input.maximumNavigationMutationBytes
  };
}
