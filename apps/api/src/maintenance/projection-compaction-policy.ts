export type ProjectionCompactionMetrics = {
  segmentCount: number;
  encodedBytes: number;
  tombstoneEntries: number;
  totalEntries: number;
  readAmplification: number;
};

export type ProjectionCompactionLimits = {
  maxDepth: number;
  maxEncodedBytes: number;
  maxTombstoneRatio: number;
  maxReadAmplification: number;
};

export type ProjectionCompactionReason =
  | "depth"
  | "bytes"
  | "tombstone_ratio"
  | "read_amplification";

export function evaluateProjectionCompaction(
  metrics: ProjectionCompactionMetrics,
  limits: ProjectionCompactionLimits
): { compact: boolean; reasons: ProjectionCompactionReason[] } {
  const reasons: ProjectionCompactionReason[] = [];
  if (metrics.segmentCount > limits.maxDepth) reasons.push("depth");
  if (metrics.encodedBytes > limits.maxEncodedBytes) reasons.push("bytes");
  if (
    metrics.totalEntries > 0
    && metrics.tombstoneEntries / metrics.totalEntries >= limits.maxTombstoneRatio
  ) {
    reasons.push("tombstone_ratio");
  }
  if (metrics.readAmplification > limits.maxReadAmplification) {
    reasons.push("read_amplification");
  }
  return { compact: reasons.length > 0, reasons };
}
