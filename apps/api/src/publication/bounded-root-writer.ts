import {
  buildOkfPublicationMetadata,
  renderMarkdownIdentityLabel,
  toBundleMarkdownHref
} from "@focowiki/okf";
import type { GenerationObjectReferenceRepository } from "../application/ports/generation-object-reference-repository.js";
import type { ClaimedPublicationImpact } from "../application/ports/publication-impact-repository.js";
import type { PublicationProjectionInput } from "../application/ports/publication-projection-input.js";
import type { ImmutableObjectWriteResult } from "./immutable-object-writer.js";
import { createGeneratedFileId } from "../domain/generated-file-id.js";
import { GENERATED_GRAPH_RESOURCES } from "../okf/generated-graph-resources.js";

const ROOT_PATHS = new Set([
  "index.md",
  "schema.md",
  "log.md",
  "_index/index.md",
  GENERATED_GRAPH_RESOURCES.index.path
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
  const writeBatch = async (impacts: ClaimedPublicationImpact[]): Promise<{
    handled: boolean;
    touchedShardCount: number;
  }> => {
    if (impacts.length === 0 || impacts.some((impact) => impact.projectionKind !== "root")) {
      return { handled: false, touchedShardCount: 0 };
    }
    const first = impacts[0]!;
    if (impacts.some((impact) =>
      impact.knowledgeBaseId !== first.knowledgeBaseId
      || impact.generationId !== first.generationId
      || impact.projectionKey !== first.projectionKey
    )) {
      throw new Error("Root projection batch must target one root path");
    }
    const impact = impacts.reduce((latest, candidate) =>
      candidate.resourceRevision > latest.resourceRevision ? candidate : latest
    );
    if (!ROOT_PATHS.has(impact.projectionKey)) {
      throw new Error("Root projection path is unsupported");
    }
    const projectionInput = requireKnowledgeBaseInput(impact);
    const rendered = renderBoundedRootFile({
      path: impact.projectionKey,
      knowledgeBase: projectionInput.descriptor,
      rootEntryCount: projectionInput.rootEntryCount,
      generationId: impact.generationId,
      ...(projectionInput.descriptor.changedAt
        ? { changedAt: projectionInput.descriptor.changedAt }
        : {})
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
  };
  return {
    write(impact: ClaimedPublicationImpact) {
      return writeBatch([impact]);
    },
    writeBatch
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
    changedAt?: string;
  };
  rootEntryCount: number;
  generationId: string;
  changedAt?: string;
}): { body: string; contentType: string } {
  const title = renderMarkdownIdentityLabel(input.knowledgeBase.name);
  if (input.path === "index.md") {
    const rootMetadata = buildOkfPublicationMetadata({
      ownership: "focowiki",
      artifactKind: "bundle_root",
      metadata: {},
      ...(input.changedAt ? { changedAt: input.changedAt } : {})
    });
    return markdown([
      "---",
      ...frontmatterLines(rootMetadata),
      "---",
      `# ${title}`,
      "",
      ...(input.knowledgeBase.description ? [input.knowledgeBase.description, ""] : []),
      "## Explore",
      "",
      `- [Browse documents](${toBundleMarkdownHref("pages/index.md")}) - ${input.rootEntryCount} top-level entries.`,
      `- [${GENERATED_GRAPH_RESOURCES.index.label}](${toBundleMarkdownHref(GENERATED_GRAPH_RESOURCES.index.path)}) - ${input.knowledgeBase.graphEdgeCount} accepted relationships.`,
      `- [Metadata schema](${toBundleMarkdownHref("schema.md")})`,
      `- [Update history](${toBundleMarkdownHref("log.md")})`,
      `- [Machine-readable indexes](${toBundleMarkdownHref("_index/index.md")})`,
      ""
    ]);
  }
  if (input.path === "schema.md") {
    const baseMetadata = {
      type: "Schema Reference",
      title: "Metadata and navigation schema",
      description: "Metadata and navigation conventions for the generated knowledge base."
    };
    const metadata = input.changedAt
      ? buildOkfPublicationMetadata({
          ownership: "focowiki",
          metadata: baseMetadata,
          changedAt: input.changedAt
        })
      : baseMetadata;
    return markdown([
      "---",
      ...frontmatterLines(metadata),
      "---",
      "# Metadata and navigation schema",
      "",
      "This knowledge base publishes native OKF 0.2 while retaining safe legacy and partially conforming metadata.",
      "Optional provenance, trust, lifecycle, and computation fields remain readable when omitted or irregular.",
      "",
      "## Recommended user metadata",
      "",
      "OKF 0.2 fields are recommended and optional for upload. Safe irregular values remain readable, while unavailable normalized signals remain null.",
      "",
      "## Focowiki-owned artifacts",
      "",
      "Generated root, navigation, index, graph, schema, log, and extension artifacts are strictly validated before publication.",
      "",
      "## Navigation",
      "",
      "Directory indexes provide parent, previous, and next links for progressive exploration.",
      "Machine-readable records include file IDs, logical paths, and direct content paths.",
      ""
    ]);
  }
  if (input.path === "log.md") {
    const changedDate = input.changedAt?.slice(0, 10);
    return markdown([
      "# Directory Update Log",
      "",
      ...(changedDate ? [`## ${changedDate}`, ""] : []),
      `* **Publication**: Published ${input.knowledgeBase.sourceFileCount} source-backed Markdown files.`,
      ""
    ]);
  }
  if (input.path === GENERATED_GRAPH_RESOURCES.index.path) {
    return markdown([
      "# Relationship graph",
      "",
      `The active generation contains ${input.knowledgeBase.graphEdgeCount} accepted relationships.`,
      "",
      `- [Machine-readable graph catalog](${toBundleMarkdownHref(GENERATED_GRAPH_RESOURCES.catalogPath)})`,
      `- [Browse source-backed files](${toBundleMarkdownHref("pages/index.md")})`,
      `- [Knowledge base](${toBundleMarkdownHref("index.md")})`,
      `- [Machine-readable indexes](${toBundleMarkdownHref("_index/index.md")})`,
      "",
      "Use the graph catalog to discover related files.",
      "Relationships are navigation hints; open the linked source Markdown files to verify context and evidence.",
      ""
    ]);
  }
  return markdown([
    "# Machine-readable indexes",
    "",
    `- [Projection catalog](${toBundleMarkdownHref("_index/catalog.json")})`,
    `- [Browse source-backed files](${toBundleMarkdownHref("pages/index.md")})`,
    `- [Knowledge base](${toBundleMarkdownHref("index.md")})`,
    `- [Relationship graph](${toBundleMarkdownHref("_graph/index.md")})`,
    ""
  ]);
}

function markdown(lines: string[]): { body: string; contentType: string } {
  return {
    body: lines.join("\n"),
    contentType: "text/markdown; charset=utf-8"
  };
}

function frontmatterLines(metadata: Record<string, unknown>): string[] {
  return Object.entries(metadata).flatMap(([key, value]) =>
    value === undefined ? [] : [`${key}: ${JSON.stringify(value)}`]);
}
