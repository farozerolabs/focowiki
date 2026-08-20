import type { DocumentResourceLane } from "./document-fixed-dag-scheduler.js";
import type { DocumentWorkKind } from "../domain/document-work-graph.js";

const WORK_RESOURCE_LANES: Readonly<Record<DocumentWorkKind, DocumentResourceLane>> = {
  prepare: "postgres_s3",
  first_layer: "generation_model",
  content_projection: "embedding",
  graphrag: "graphrag_adapter",
  relation_reconcile: "coordination",
  knowledge_projection: "projection",
  activate: "activation",
  cleanup: "cleanup"
};

export function documentWorkResourceLane(kind: DocumentWorkKind): DocumentResourceLane {
  return WORK_RESOURCE_LANES[kind];
}
