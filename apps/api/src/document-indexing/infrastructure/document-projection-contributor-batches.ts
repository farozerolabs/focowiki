export function splitDocumentProjectionContributors<T>(input: {
  contributors: readonly T[];
  pageCount: number;
  maximumPairs: number;
}): readonly (readonly T[])[] {
  if (!Number.isSafeInteger(input.pageCount) || input.pageCount < 0
    || !Number.isSafeInteger(input.maximumPairs) || input.maximumPairs < 1) {
    throw Object.assign(new Error("Projection contributor batch input is invalid"), {
      code: "invalid_input"
    });
  }
  if (input.pageCount === 0 || input.contributors.length === 0) return [];
  const batchSize = Math.max(1, Math.floor(
    input.maximumPairs / input.pageCount
  ));
  const batches: T[][] = [];
  for (let offset = 0; offset < input.contributors.length; offset += batchSize) {
    batches.push(input.contributors.slice(offset, offset + batchSize));
  }
  return batches;
}
