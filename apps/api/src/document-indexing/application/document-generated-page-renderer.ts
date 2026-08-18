import { createHash } from "node:crypto";
import type {
  ModelSuggestions,
  SourceMetadata,
  SourceMetadataDefaults
} from "@focowiki/okf";
import { renderPageFile } from "../../okf/generated-files.js";
import type { SourcePathRewrite } from "../../okf/deleted-source-links.js";

export function renderDocumentSourcePage(input: {
  source: {
    sourceFilePublicId: string;
    logicalPath: string;
    sourceLinkBaseLogicalPath?: string;
    body: string;
    metadata: SourceMetadata;
    sourceMetadata: SourceMetadataDefaults;
    modelSuggestions?: ModelSuggestions | null;
  };
  related: readonly {
    targetSourceFilePublicId: string;
    path: string;
    title: string;
    direction: "incoming" | "outgoing" | "bidirectional";
    relationKind: "references" | "related";
    reason: string;
  }[];
  semanticEntities: readonly {
    label: string;
    kind: string;
    description: string | null;
    confidence: number;
    evidencePaths: readonly string[];
  }[];
  removedSourceLogicalPaths: readonly string[];
  sourcePathRewrites: readonly SourcePathRewrite[];
}) {
  validateInput(input);
  const logicalPath = `pages/${input.source.logicalPath}`;
  const content = renderPageFile({
    pagePath: logicalPath,
    metadata: input.source.metadata,
    sourceMetadata: input.source.sourceMetadata,
    suggestions: input.source.modelSuggestions ?? null,
    semanticContext: {
      entities: input.semanticEntities.map((entity) => ({
        ...entity,
        evidencePaths: entity.evidencePaths.map(generatedEvidencePath)
      }))
    },
    graphLinks: input.related.map((item) => ({
      path: item.path.startsWith("pages/") ? item.path : `pages/${item.path}`,
      title: item.title,
      relationType: item.relationKind,
      direction: item.direction === "incoming" ? "incoming" : "outgoing",
      weight: 1,
      reason: item.reason
    }))
  }, input.source.body, {
    sourceLinkBaseLogicalPath: input.source.sourceLinkBaseLogicalPath
      ?? input.source.logicalPath,
    removedSourceLogicalPaths: input.removedSourceLogicalPaths,
    sourcePathRewrites: input.sourcePathRewrites
  });
  const bytes = Buffer.from(content, "utf8");
  return {
    logicalPath,
    normalizedPath: logicalPath.toLocaleLowerCase("en-US"),
    entryKind: "source" as const,
    sourceFilePublicId: input.source.sourceFilePublicId,
    bytes,
    byteCount: bytes.byteLength,
    checksumSha256: createHash("sha256").update(bytes).digest("hex")
  };
}

function generatedEvidencePath(logicalPath: string): string {
  return logicalPath.startsWith("pages/") ? logicalPath : `pages/${logicalPath}`;
}

function validateInput(input: Parameters<typeof renderDocumentSourcePage>[0]): void {
  if (!input.source.sourceFilePublicId || !input.source.logicalPath
    || !input.source.logicalPath.toLowerCase().endsWith(".md")
    || typeof input.source.body !== "string"
    || input.related.length > 1_000
    || input.semanticEntities.length > 1_000) {
    throw rendererError("input_invalid");
  }
}

function rendererError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document page renderer error: ${code}`), { code });
}
