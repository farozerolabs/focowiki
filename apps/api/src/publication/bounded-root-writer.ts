import {
  renderMarkdownIdentityLabel,
  toBundleMarkdownHref
} from "@focowiki/okf";
import type { GenerationObjectReferenceRepository } from "../application/ports/generation-object-reference-repository.js";
import type { ClaimedPublicationImpact } from "../application/ports/publication-impact-repository.js";
import type { PublicationProjectionInput } from "../application/ports/publication-projection-input.js";
import type { ImmutableObjectWriteResult } from "./immutable-object-writer.js";
import { createGeneratedFileId } from "../domain/generated-file-id.js";

const ROOT_PATHS = new Set([
  "index.md",
  "schema.md",
  "log.md",
  "_index/index.md",
  "_graph/index.md"
]);

export function createBoundedRootWriter(input: {
  references: GenerationObjectReferenceRepository;
  immutableObjects: {
    write: (input: {
      body: string | Uint8Array;
      contentType: string;
      formatVersion?: number;
    }) => Promise<ImmutableObjectWriteResult>;
  };
}) {
  return {
    async write(impact: ClaimedPublicationImpact): Promise<{
      handled: boolean;
      touchedShardCount: number;
    }> {
      if (impact.projectionKind !== "root") {
        return { handled: false, touchedShardCount: 0 };
      }
      if (!ROOT_PATHS.has(impact.projectionKey)) {
        throw new Error("Root projection path is unsupported");
      }
      const projectionInput = requireKnowledgeBaseInput(impact);
      const rendered = renderBoundedRootFile({
        path: impact.projectionKey,
        knowledgeBase: projectionInput.descriptor,
        rootEntryCount: projectionInput.rootEntryCount,
        generationId: impact.generationId
      });
      const object = await input.immutableObjects.write({
        body: rendered.body,
        contentType: rendered.contentType
      });
      await input.references.stageUpsert({
        knowledgeBaseId: impact.knowledgeBaseId,
        generationId: impact.generationId,
        refKind: "root",
        refKey: impact.projectionKey,
        fileId: createGeneratedFileId({
          refKind: "root",
          refKey: impact.projectionKey,
          sourceFileId: null
        }),
        checksumSha256: object.checksumSha256,
        formatVersion: object.formatVersion,
        logicalPath: impact.projectionKey,
        sourceFileId: null,
        projectionShardId: null
      });
      return { handled: true, touchedShardCount: 1 };
    }
  };
}

function requireKnowledgeBaseInput(
  impact: ClaimedPublicationImpact
): Extract<PublicationProjectionInput, { kind: "knowledge_base" }> {
  if (!impact.projectionInput || impact.projectionInput.kind !== "knowledge_base") {
    throw new Error("Root impact is missing its frozen knowledge-base input");
  }
  return impact.projectionInput;
}

export function renderBoundedRootFile(input: {
  path: string;
  knowledgeBase: {
    id: string;
    name: string;
    description: string | null;
    sourceFileCount: number;
    graphEdgeCount: number;
  };
  rootEntryCount: number;
  generationId: string;
}): { body: string; contentType: string } {
  const title = renderMarkdownIdentityLabel(input.knowledgeBase.name);
  if (input.path === "index.md") {
    return markdown([
      "---",
      'okf_version: "0.1"',
      "---",
      `# ${title}`,
      "",
      ...(input.knowledgeBase.description ? [input.knowledgeBase.description, ""] : []),
      "## Explore",
      "",
      `- [Browse documents](${toBundleMarkdownHref("pages/index.md")}) - ${input.rootEntryCount} top-level entries.`,
      `- [Relationship graph](${toBundleMarkdownHref("_graph/index.md")}) - ${input.knowledgeBase.graphEdgeCount} accepted relationships.`,
      `- [Metadata schema](${toBundleMarkdownHref("schema.md")})`,
      `- [Update history](${toBundleMarkdownHref("log.md")})`,
      `- [Machine-readable indexes](${toBundleMarkdownHref("_index/index.md")})`,
      ""
    ]);
  }
  if (input.path === "schema.md") {
    return markdown([
      "---",
      'type: "Schema Reference"',
      'title: "Metadata and navigation schema"',
      'description: "Metadata and navigation conventions for the generated knowledge base."',
      "---",
      "# Metadata and navigation schema",
      "",
      "Source-backed Markdown files retain safe frontmatter fields and stable file identity.",
      "Directory indexes provide parent, previous, and next links for progressive exploration.",
      "Machine-readable records include file IDs, logical paths, and direct content paths.",
      ""
    ]);
  }
  if (input.path === "log.md") {
    return markdown([
      "# Directory Update Log",
      "",
      `- Generation \`${input.generationId}\` published ${input.knowledgeBase.sourceFileCount} source-backed Markdown files.`,
      ""
    ]);
  }
  if (input.path === "_graph/index.md") {
    return markdown([
      "# Relationship graph",
      "",
      `The active generation contains ${input.knowledgeBase.graphEdgeCount} accepted relationships.`,
      "",
      `- [Machine-readable graph catalog](${toBundleMarkdownHref("_index/catalog.json")})`,
      `- [Browse source-backed files](${toBundleMarkdownHref("pages/index.md")})`,
      ""
    ]);
  }
  return markdown([
    "# Machine-readable indexes",
    "",
    `- [Projection catalog](${toBundleMarkdownHref("_index/catalog.json")})`,
    `- [Browse source-backed files](${toBundleMarkdownHref("pages/index.md")})`,
    ""
  ]);
}

function markdown(lines: string[]): { body: string; contentType: string } {
  return {
    body: lines.join("\n"),
    contentType: "text/markdown; charset=utf-8"
  };
}
