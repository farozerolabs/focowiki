export type DocumentRelationPlan = {
  pairPublicIds: readonly string[];
  relationPublicIds: readonly string[];
  affectedSourceFilePublicIds: readonly string[];
};

export type ParsedDocumentRelationPlan = Omit<
  DocumentRelationPlan,
  "relationPublicIds"
> & {
  relationPublicIds: readonly string[] | null;
};

export function documentProjectionRenderableSourceFileIds(input: {
  currentSourceFilePublicId: string;
  affectedSourceFilePublicIds: readonly string[];
  relations: readonly {
    firstSourceFilePublicId: string;
    secondSourceFilePublicId: string;
  }[];
}): string[] {
  return [...new Set([
    input.currentSourceFilePublicId,
    ...input.affectedSourceFilePublicIds,
    ...input.relations.flatMap((relation) => [
      relation.firstSourceFilePublicId,
      relation.secondSourceFilePublicId
    ])
  ])].sort();
}

export function documentProjectionAvailableSourceFileIds(input: {
  currentSourceFilePublicId: string;
  requestedSourceFilePublicIds: readonly string[];
  availableBaseSourceFilePublicIds: readonly string[];
}): string[] {
  const available = new Set(input.availableBaseSourceFilePublicIds);
  return [...new Set([
    input.currentSourceFilePublicId,
    ...input.requestedSourceFilePublicIds.filter((sourceFilePublicId) =>
      sourceFilePublicId === input.currentSourceFilePublicId
      || available.has(sourceFilePublicId)
    )
  ])];
}

export function readDocumentRelationPlan(
  value: Readonly<Record<string, unknown>> | undefined
): ParsedDocumentRelationPlan {
  if (!value
    || value.schemaVersion !== "document-relation-reconciliation-receipt-v1"
    || !Array.isArray(value.pairPublicIds)
    || !Array.isArray(value.affectedSourceFilePublicIds)
    || value.pairPublicIds.some((item) => typeof item !== "string")
    || (value.relationPublicIds !== undefined
      && (!Array.isArray(value.relationPublicIds)
        || value.relationPublicIds.some((item) => typeof item !== "string")))
    || value.affectedSourceFilePublicIds.some(
      (item) => typeof item !== "string"
    )) {
    throw projectionSupportError("relation_reconciliation_receipt_invalid");
  }
  return {
    pairPublicIds: value.pairPublicIds as string[],
    relationPublicIds: value.relationPublicIds === undefined
      ? null : value.relationPublicIds as string[],
    affectedSourceFilePublicIds: value.affectedSourceFilePublicIds as string[]
  };
}

function projectionSupportError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document knowledge projection error: ${code}`), {
    code
  });
}
