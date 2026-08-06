import type { StorageVnextCandidateDependency } from "../release/ports.js";

export type StorageVnextPublicationBatchPlan = {
  sourcePaths: string[];
  directoryPaths: string[];
  graphPublicIds: string[];
  linkPublicIds: string[];
  searchSourceFilePublicIds: string[];
  rootPaths: string[];
};

export function planStorageVnextPublicationBatch(input: {
  dependencies: readonly StorageVnextCandidateDependency[];
  maximumDependencies: number;
}): StorageVnextPublicationBatchPlan {
  if (
    !Number.isSafeInteger(input.maximumDependencies)
    || input.maximumDependencies < 1
    || input.dependencies.length > input.maximumDependencies
  ) {
    throw new Error("Storage vNext publication dependency budget exceeded");
  }
  const plan: StorageVnextPublicationBatchPlan = {
    sourcePaths: [],
    directoryPaths: [],
    graphPublicIds: [],
    linkPublicIds: [],
    searchSourceFilePublicIds: [],
    rootPaths: []
  };
  for (const dependency of input.dependencies) {
    if (!dependency.publicId || !dependency.reasonCode) {
      throw new Error("Storage vNext publication dependency is invalid");
    }
    switch (dependency.kind) {
      case "path":
        plan.sourcePaths.push(dependency.publicId);
        break;
      case "ancestor":
        plan.directoryPaths.push(dependency.publicId);
        break;
      case "graph":
        plan.graphPublicIds.push(dependency.publicId);
        break;
      case "link":
        plan.linkPublicIds.push(dependency.publicId);
        break;
      case "search":
        plan.searchSourceFilePublicIds.push(dependency.publicId);
        break;
      case "index":
      case "schema":
      case "log":
        plan.rootPaths.push(dependency.publicId);
        break;
      case "scope":
        break;
    }
  }
  return {
    sourcePaths: stableUnique(plan.sourcePaths),
    directoryPaths: stableUnique(plan.directoryPaths),
    graphPublicIds: stableUnique(plan.graphPublicIds),
    linkPublicIds: stableUnique(plan.linkPublicIds),
    searchSourceFilePublicIds: stableUnique(plan.searchSourceFilePublicIds),
    rootPaths: stableUnique(plan.rootPaths)
  };
}

function stableUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareUtf8);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
