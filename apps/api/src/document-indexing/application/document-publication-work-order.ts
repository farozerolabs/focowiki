import type { DocumentPublicationWorkNode } from
  "./document-publication-job-plan.js";

export function eligibleDocumentPublicationWork(input: Readonly<{
  work: readonly DocumentPublicationWorkNode[];
  completedIdentities: ReadonlySet<string>;
  runningIdentities: ReadonlySet<string>;
  limit: number;
}>): readonly DocumentPublicationWorkNode[] {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1
    || input.limit > 256) {
    throw new Error("DOCUMENT_PUBLICATION_DAG_LIMIT_INVALID");
  }
  return input.work.filter((node) =>
    !input.completedIdentities.has(node.identity)
      && !input.runningIdentities.has(node.identity)
      && node.dependsOn.every((dependency) =>
        input.completedIdentities.has(dependency)))
    .slice(0, input.limit);
}
