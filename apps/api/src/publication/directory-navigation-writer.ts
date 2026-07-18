import {
  renderMarkdownIdentityLabel,
  toBundleMarkdownHref
} from "@focowiki/okf";
import type { DirectoryNavigationRepository, PersistentDirectoryLeaf } from "../application/ports/directory-navigation-repository.js";
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
      const touchedLeaves = new Map<string, PersistentDirectoryLeaf>();
      const removedLeafIds = new Set<string>();
      let summary = null as Awaited<ReturnType<typeof input.navigation.getSummary>>;
      let changed = false;
      for (const impact of impacts) {
        const projectionInput = requireNavigationInput(impact);
        for (const target of projectionInput.targets) {
        const mutation = await input.navigation.applyEntry({
          knowledgeBaseId: impact.knowledgeBaseId,
          directoryPath,
          entryId: target.entryId,
          desiredEntry: target.desiredEntry,
          limits: input.limits
        });
        if (!mutation.changed) continue;
        changed = true;
        summary = mutation.summary;
        for (const leafId of mutation.removedLeafIds) {
          removedLeafIds.add(leafId);
          touchedLeaves.delete(leafId);
        }
        for (const leaf of mutation.touchedLeaves) {
          if (!removedLeafIds.has(leaf.id)) touchedLeaves.set(leaf.id, leaf);
        }
        }
      }
      if (!changed || !summary) return { handled: true, touchedShardCount: 0 };
      for (const leafId of removedLeafIds) {
        await input.references.stageDelete({
          knowledgeBaseId: first.knowledgeBaseId,
          generationId: first.generationId,
          refKind: "directory_leaf",
          refKey: directoryLeafRefKey(directoryPath, leafId),
          logicalPath: directoryLeafPath(directoryPath, leafId),
          sourceFileId: null
        });
      }
      for (const leaf of touchedLeaves.values()) {
        await writeReference(input, first, {
          refKind: "directory_leaf",
          refKey: directoryLeafRefKey(directoryPath, leaf.id),
          logicalPath: directoryLeafPath(directoryPath, leaf.id),
          body: renderDirectoryLeafMarkdown({ directoryPath, leaf })
        });
      }
      await writeReference(input, first, {
        refKind: "directory_root",
        refKey: `directory-root:${directoryPath}`,
        logicalPath: `${directoryPath}/index.md`,
        body: renderDirectoryRootMarkdown({
          directoryPath,
          entryCount: summary.entryCount,
          firstLeafId: summary.firstLeafId
        })
      });
      return { handled: true, touchedShardCount: touchedLeaves.size + 1 };
    };
  return {
    write(impact: ClaimedPublicationImpact) {
      return writeBatch([impact]);
    },
    writeBatch
  };
}

async function writeReference(
  input: Parameters<typeof createDirectoryNavigationWriter>[0],
  impact: ClaimedPublicationImpact,
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
    knowledgeBaseId: impact.knowledgeBaseId,
    generationId: impact.generationId,
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
