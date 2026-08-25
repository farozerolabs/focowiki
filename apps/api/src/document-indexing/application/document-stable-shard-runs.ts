import type { DocumentSemanticPartDescriptor } from
  "./document-semantic-resource-packets.js";
import { comparePortableRecordKeys } from "@focowiki/okf";

export function selectStableShardOwners(
  descriptors: readonly DocumentSemanticPartDescriptor[],
  key: string,
  includeDuplicateRanges = false
): DocumentSemanticPartDescriptor[] {
  if (descriptors.length === 0) return [];
  const containing = descriptors.filter((descriptor) =>
    comparePortableRecordKeys(descriptor.firstKey, key) <= 0
      && comparePortableRecordKeys(key, descriptor.lastKey) <= 0);
  if (containing.length > 0) {
    return includeDuplicateRanges ? containing : [containing[0]!];
  }
  const predecessor = [...descriptors].reverse().find((descriptor) =>
    comparePortableRecordKeys(descriptor.firstKey, key) < 0);
  return [predecessor ?? descriptors[0]!];
}

export function partitionStableShardRuns(
  descriptors: readonly DocumentSemanticPartDescriptor[],
  touched: readonly DocumentSemanticPartDescriptor[]
): DocumentSemanticPartDescriptor[][] {
  const touchedPaths = new Set(touched.map((descriptor) => descriptor.path));
  const runs: DocumentSemanticPartDescriptor[][] = [];
  let current: DocumentSemanticPartDescriptor[] = [];
  for (const descriptor of descriptors) {
    if (touchedPaths.has(descriptor.path)) {
      current.push(descriptor);
      continue;
    }
    if (current.length > 0) runs.push(current);
    current = [];
  }
  if (current.length > 0) runs.push(current);
  return runs;
}
