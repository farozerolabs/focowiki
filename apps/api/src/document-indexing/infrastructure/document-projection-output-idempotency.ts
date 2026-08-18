import type { PersistentDirectoryLeaf } from
  "../../application/ports/directory-navigation-repository.js";
import type { GeneratedPageHead } from
  "./postgres-generated-page-repository.js";
import type { DocumentProjectionScopeOutput } from
  "./postgres-projection-scope-output-repository.js";

export async function omitAppliedProjectionScopeEffects(input: {
  outputs: readonly DocumentProjectionScopeOutput[];
  heads: readonly GeneratedPageHead[];
  readDirectory(directoryPath: string): Promise<readonly PersistentDirectoryLeaf[]>;
}): Promise<readonly DocumentProjectionScopeOutput[]> {
  const headByPath = new Map(input.heads.map((head) => [
    head.normalizedPath,
    head
  ]));
  const directoryPaths = [...new Set(input.outputs.flatMap((output) =>
    output.navigationMutations.map((mutation) => mutation.directoryPath)))];
  const directories = new Map(await Promise.all(directoryPaths.map(
    async (path) => [path, await input.readDirectory(path)] as const
  )));
  return input.outputs.map((output) => ({
    ...output,
    pages: output.pages.filter((page) => !samePage(
      headByPath.get(page.normalizedPath),
      page
    )),
    removedNormalizedPaths: output.removedNormalizedPaths.filter((path) =>
      headByPath.has(path)),
    navigationMutations: output.navigationMutations.filter((mutation) =>
      !sameNavigation(directories.get(mutation.directoryPath) ?? [], mutation))
  }));
}

function samePage(
  head: GeneratedPageHead | undefined,
  page: DocumentProjectionScopeOutput["pages"][number]
): boolean {
  return Boolean(head)
    && head!.logicalPath === page.logicalPath
    && head!.entryKind === page.entryKind
    && head!.sourceFilePublicId === page.sourceFilePublicId
    && head!.sourceRevisionPublicId === page.sourceRevisionPublicId
    && head!.objectId === page.objectId
    && head!.checksumSha256 === page.checksumSha256
    && head!.byteCount === page.byteCount;
}

function sameNavigation(
  current: readonly PersistentDirectoryLeaf[],
  mutation: DocumentProjectionScopeOutput["navigationMutations"][number]
): boolean {
  const byId = new Map(current.map((leaf) => [leaf.id, leaf]));
  return mutation.removedLeafIds.every((leafId) => !byId.has(leafId))
    && mutation.touchedLeaves.every((leaf) => {
      const active = byId.get(leaf.id);
      return active?.previousLeafId === leaf.previousLeafId
        && active.nextLeafId === leaf.nextLeafId
        && active.revision === leaf.revision
        && JSON.stringify(active.entries) === JSON.stringify(leaf.entries);
    });
}
