export const DOCUMENT_WORK_KINDS = [
  "prepare",
  "first_layer",
  "content_projection",
  "graphrag",
  "relation_reconcile",
  "knowledge_projection",
  "activate",
  "cleanup"
] as const;

export type DocumentWorkKind = (typeof DOCUMENT_WORK_KINDS)[number];

const PREREQUISITES: Readonly<Record<DocumentWorkKind, readonly DocumentWorkKind[]>> = {
  prepare: [],
  first_layer: ["prepare"],
  content_projection: ["prepare"],
  graphrag: ["first_layer"],
  relation_reconcile: ["first_layer", "content_projection", "graphrag"],
  knowledge_projection: ["content_projection", "relation_reconcile"],
  activate: ["knowledge_projection"],
  cleanup: ["activate"]
};

export function documentWorkPrerequisites(
  kind: DocumentWorkKind
): readonly DocumentWorkKind[] {
  return PREREQUISITES[kind];
}

export function nextDocumentWork(
  completed: ReadonlySet<DocumentWorkKind>
): DocumentWorkKind[] {
  return DOCUMENT_WORK_KINDS.filter((kind) =>
    !completed.has(kind)
    && PREREQUISITES[kind].every((prerequisite) => completed.has(prerequisite))
  );
}
