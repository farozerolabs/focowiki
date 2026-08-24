export type DocumentProjectionMetrics = Readonly<{
  changedRecordCount: number;
  chunkCount: number;
  peakBufferedRecordCount: number;
  touchedShardCount: number;
}>;

export function readDocumentProjectionMetrics(
  value: object
): DocumentProjectionMetrics | null {
  if (!("projectionMetrics" in value)) return null;
  const metrics = value.projectionMetrics;
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) {
    return null;
  }
  const candidate = metrics as Record<string, unknown>;
  for (const field of [
    "changedRecordCount",
    "chunkCount",
    "peakBufferedRecordCount",
    "touchedShardCount"
  ]) {
    if (!Number.isSafeInteger(candidate[field]) || Number(candidate[field]) < 0) {
      return null;
    }
  }
  return candidate as DocumentProjectionMetrics;
}
