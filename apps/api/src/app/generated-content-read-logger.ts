import type { GeneratedContentReadMetrics } from "../application/generated-content-read.js";
import type { RuntimeLogger } from "../logger.js";

export function reportGeneratedContentRead(
  logger: RuntimeLogger | undefined,
  plane: "admin" | "developer_openapi",
  metrics: GeneratedContentReadMetrics
): void {
  logger?.info("Generated content read completed", {
    plane,
    metadataLookupMs: Math.round(metrics.metadataLookupMs),
    objectTransferMs:
      metrics.objectTransferMs === null ? null : Math.round(metrics.objectTransferMs),
    outcome: metrics.outcome
  });
}
