import type { SourceMetadata } from "@focowiki/okf";
import type {
  BundleFileDraft,
  BundleTreeEntryDraft,
  PreviousBundleFileForPublication,
  PublishOkfReleaseInput
} from "./publication.js";
import type { GeneratedPageSummary } from "./publication-files.js";

export type CopyForwardTreeState = {
  seenDirectories: Set<string>;
  pendingEntries: BundleTreeEntryDraft[];
  entryCount: number;
};

export async function copyForwardUnchangedPageFiles(input: {
  publication: PublishOkfReleaseInput;
  nextFileId: () => string;
  publicFilePlans: {
    bySourceId: Map<string, { publicFileName: string; pagePath: string }>;
  };
  treeState: CopyForwardTreeState;
  registerPublishedFile: (
    file: BundleFileDraft,
    treeState: CopyForwardTreeState
  ) => Promise<void>;
  registerPageSummary: (summary: GeneratedPageSummary) => Promise<void>;
}): Promise<Set<string>> {
  const dirtySourceFileIds = new Set(input.publication.dirtySourceFileIds ?? []);
  const copiedSourceFileIds = new Set<string>();

  if (!input.publication.fetchPreviousBundleFilePage || dirtySourceFileIds.size === 0) {
    return copiedSourceFileIds;
  }

  let cursor: string | null = null;

  do {
    const page = await input.publication.fetchPreviousBundleFilePage({
      cursor,
      limit: input.publication.pageSize
    });
    const copiedFiles: BundleFileDraft[] = [];

    for (const previous of page.items) {
      if (
        previous.fileKind !== "page" ||
        !previous.sourceFileId ||
        dirtySourceFileIds.has(previous.sourceFileId)
      ) {
        continue;
      }

      const plan = input.publicFilePlans.bySourceId.get(previous.sourceFileId);
      if (!plan || plan.pagePath !== previous.logicalPath) {
        continue;
      }

      const copied = copyPreviousBundleFile({
        publication: input.publication,
        nextFileId: input.nextFileId,
        previous
      });

      copiedFiles.push(copied);
      copiedSourceFileIds.add(previous.sourceFileId);
      await input.registerPageSummary(summaryFromCopiedPage(previous));
    }

    if (copiedFiles.length > 0) {
      await input.publication.persistBundleFiles(copiedFiles);
      for (const copied of copiedFiles) {
        await input.registerPublishedFile(copied, input.treeState);
      }
    }

    cursor = page.nextCursor;
  } while (cursor);

  return copiedSourceFileIds;
}

function copyPreviousBundleFile(input: {
  publication: PublishOkfReleaseInput;
  nextFileId: () => string;
  previous: PreviousBundleFileForPublication;
}): BundleFileDraft {
  return {
    id: input.nextFileId(),
    knowledgeBaseId: input.publication.knowledgeBaseId,
    releaseId: input.publication.releaseId,
    sourceFileId: input.previous.sourceFileId,
    fileKind: input.previous.fileKind,
    logicalPath: input.previous.logicalPath,
    objectKey: input.previous.objectKey,
    contentType: input.previous.contentType,
    sizeBytes: input.previous.sizeBytes,
    checksumSha256: input.previous.checksumSha256,
    okfType: input.previous.okfType,
    title: input.previous.title,
    description: input.previous.description,
    tags: [...input.previous.tags],
    frontmatter: { ...input.previous.frontmatter }
  };
}

function summaryFromCopiedPage(file: PreviousBundleFileForPublication): GeneratedPageSummary {
  if (!file.sourceFileId) {
    throw new Error("Copied page must have a source file id");
  }

  return {
    pagePath: file.logicalPath,
    fileId: file.sourceFileId,
    metadata: { ...file.frontmatter } as SourceMetadata,
    suggestions: null,
    graphLinks: []
  };
}
