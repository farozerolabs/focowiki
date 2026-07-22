import {
  renderMarkdownIdentityLabel,
  toBundleMarkdownHref
} from "@focowiki/okf";
import type {
  DirectoryNavigationRepository,
  PersistentDirectoryLeaf
} from "../application/ports/directory-navigation-repository.js";
import type { GenerationObjectReferenceRepository } from "../application/ports/generation-object-reference-repository.js";
import type { ClaimedPublicationImpact } from "../application/ports/publication-impact-repository.js";
import type { PublicationProjectionInput } from "../application/ports/publication-projection-input.js";
import type { OrderedDirectoryLeafLimits } from "./ordered-directory-leaves.js";
import type { ImmutableObjectWriteResult } from "./immutable-object-writer.js";
import { createGeneratedFileId } from "../domain/generated-file-id.js";

export function createDirectoryNavigationWriter(input: {
  navigation: DirectoryNavigationRepository;
  references: GenerationObjectReferenceRepository;
  immutableObjects: {
    write: (input: {
      body: string | Uint8Array;
      contentType: string;
      formatVersion?: number;
    }) => Promise<ImmutableObjectWriteResult>;
  };
  limits: OrderedDirectoryLeafLimits;
}) {
  const writeEntries = async (request: {
    knowledgeBaseId: string;
    generationId: string;
    directoryPath: string;
    entries: Array<{
      entryId: string;
      desiredEntry: PersistentDirectoryLeaf["entries"][number] | null;
    }>;
    writeRootWhenUnchanged?: boolean;
  }): Promise<{ handled: true; touchedShardCount: number }> => {
    const mutation = await input.navigation.applyEntries({
      knowledgeBaseId: request.knowledgeBaseId,
      generationId: request.generationId,
      directoryPath: request.directoryPath,
      entries: request.entries,
      limits: input.limits
    });
    if (!mutation.changed && !request.writeRootWhenUnchanged) {
      return { handled: true, touchedShardCount: 0 };
    }
    for (const leafId of mutation.removedLeafIds) {
      await input.references.stageDelete({
        knowledgeBaseId: request.knowledgeBaseId,
        generationId: request.generationId,
        refKind: "directory_leaf",
        refKey: directoryLeafRefKey(request.directoryPath, leafId),
        logicalPath: directoryLeafPath(request.directoryPath, leafId),
        sourceFileId: null
      });
    }
    for (const leaf of mutation.touchedLeaves) {
      await writeReference(input, request, {
        refKind: "directory_leaf",
        refKey: directoryLeafRefKey(request.directoryPath, leaf.id),
        logicalPath: directoryLeafPath(request.directoryPath, leaf.id),
        body: renderDirectoryLeafMarkdown({ directoryPath: request.directoryPath, leaf })
      });
    }
    await writeReference(input, request, {
      refKind: "directory_root",
      refKey: `directory-root:${request.directoryPath}`,
      logicalPath: `${request.directoryPath}/index.md`,
      body: renderDirectoryRootMarkdown({
        directoryPath: request.directoryPath,
        entryCount: mutation.summary.entryCount,
        firstLeafId: mutation.summary.firstLeafId
      })
    });
    return {
      handled: true,
      touchedShardCount: mutation.touchedLeaves.length + 1
    };
  };
  const writeBatch = async (impacts: ClaimedPublicationImpact[]): Promise<{
    handled: boolean;
    touchedShardCount: number;
  }> => {
    if (impacts.length === 0 || impacts.some((impact) => impact.projectionKind !== "directory")) {
      return { handled: false, touchedShardCount: 0 };
    }
    const first = impacts[0]!;
    if (impacts.some((impact) => impact.projectionKey !== first.projectionKey)) {
      throw new Error("Directory projection batch must target one directory");
    }
    const directoryPath = generatedDirectoryPath(first.projectionKey);
    return writeEntries({
      knowledgeBaseId: first.knowledgeBaseId,
      generationId: first.generationId,
      directoryPath,
      entries: impacts.flatMap((impact) => requireNavigationInput(impact).targets)
    });
  };
  return {
    write(impact: ClaimedPublicationImpact) {
      return writeBatch([impact]);
    },
    writeBatch,
    writeEntries
  };
}

async function writeReference(
  input: Parameters<typeof createDirectoryNavigationWriter>[0],
  context: { knowledgeBaseId: string; generationId: string },
  file: {
    refKind: string;
    refKey: string;
    logicalPath: string;
    body: string;
  }
): Promise<void> {
  const object = await input.immutableObjects.write({
    body: file.body,
    contentType: "text/markdown; charset=utf-8"
  });
  await input.references.stageUpsert({
    knowledgeBaseId: context.knowledgeBaseId,
    generationId: context.generationId,
    refKind: file.refKind,
    refKey: file.refKey,
    fileId: createGeneratedFileId({
      refKind: file.refKind,
      refKey: file.refKey,
      sourceFileId: null
    }),
    checksumSha256: object.checksumSha256,
    formatVersion: object.formatVersion,
    logicalPath: file.logicalPath,
    sourceFileId: null,
    projectionShardId: null
  });
}

export function renderDirectoryRootMarkdown(input: {
  directoryPath: string;
  entryCount: number;
  firstLeafId: string | null;
}): string {
  const title = directoryTitle(input.directoryPath);
  const parent = parentDirectoryIndex(input.directoryPath);
  return [
    "---",
    'type: "directory-index"',
    `title: ${JSON.stringify(`${title} index`)}`,
    'navigation_only: true',
    `entry_count: ${input.entryCount}`,
    "---",
    `# ${renderMarkdownIdentityLabel(title)}`,
    "",
    ...(parent ? [`[Parent directory](${toBundleMarkdownHref(parent)})`, ""] : []),
    input.firstLeafId
      ? `[Browse entries](${toBundleMarkdownHref(directoryLeafPath(input.directoryPath, input.firstLeafId))})`
      : "This directory has no published Markdown files.",
    ""
  ].join("\n");
}

export function renderDirectoryLeafMarkdown(input: {
  directoryPath: string;
  leaf: PersistentDirectoryLeaf;
}): string {
  const navigation = [
    `[Directory index](${toBundleMarkdownHref(`${input.directoryPath}/index.md`)})`,
    input.leaf.previousLeafId
      ? `[Previous](${toBundleMarkdownHref(directoryLeafPath(input.directoryPath, input.leaf.previousLeafId))})`
      : null,
    input.leaf.nextLeafId
      ? `[Next](${toBundleMarkdownHref(directoryLeafPath(input.directoryPath, input.leaf.nextLeafId))})`
      : null
  ].filter((value): value is string => Boolean(value)).join(" · ");
  const entries = input.leaf.entries.map((entry) =>
    `- [${renderMarkdownIdentityLabel(entry.name)}](${toBundleMarkdownHref(entry.targetPath)})`
  );
  return [
    "---",
    'type: "directory-index-page"',
    `title: ${JSON.stringify(`${directoryTitle(input.directoryPath)} entries`)}`,
    'navigation_only: true',
    `leaf_id: ${JSON.stringify(input.leaf.id)}`,
    `entry_count: ${input.leaf.entries.length}`,
    "---",
    `# ${renderMarkdownIdentityLabel(directoryTitle(input.directoryPath))} entries`,
    "",
    navigation,
    "",
    ...entries,
    ""
  ].join("\n");
}

function requireNavigationInput(
  impact: ClaimedPublicationImpact
): Extract<PublicationProjectionInput, { kind: "navigation" }> {
  if (!impact.projectionInput || impact.projectionInput.kind !== "navigation") {
    throw new Error("Directory impact is missing its frozen navigation input");
  }
  return impact.projectionInput;
}

function generatedDirectoryPath(relativePath: string): string {
  return relativePath ? `pages/${relativePath}` : "pages";
}

function directoryLeafRefKey(directoryPath: string, leafId: string): string {
  return `directory-leaf:${directoryPath}:${leafId}`;
}

function directoryLeafPath(directoryPath: string, leafId: string): string {
  return `${directoryPath}/index-${encodeURIComponent(leafId)}.md`;
}

function directoryTitle(directoryPath: string): string {
  return directoryPath === "pages" ? "Documents" : directoryPath.split("/").at(-1) ?? "Documents";
}

function parentDirectoryIndex(directoryPath: string): string | null {
  if (directoryPath === "pages") return "/index.md";
  const segments = directoryPath.split("/");
  segments.pop();
  return `/${segments.join("/")}/index.md`;
}
