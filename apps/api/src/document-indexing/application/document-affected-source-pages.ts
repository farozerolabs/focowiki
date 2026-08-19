import type {
  ModelSuggestions,
  SourceMetadata,
  SourceMetadataDefaults
} from "@focowiki/okf";
import type { CanonicalFileRelation } from "../domain/file-relation.js";
import { renderDocumentSourcePage } from "./document-generated-page-renderer.js";
import type { SourcePathRewrite } from "../../okf/deleted-source-links.js";
import {
  documentRelatedProjectionRecord,
  type DocumentProjectionRelation
} from "./document-machine-record.js";
import { presentRelatedFiles } from "./document-related-file-presentation.js";

export type AffectedDocumentSource = {
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  resourceRevision: number;
  logicalPath: string;
  sourceLinkBaseLogicalPath?: string;
  title: string;
  body: string;
  metadata: SourceMetadata;
  sourceMetadata: SourceMetadataDefaults;
  modelSuggestions?: ModelSuggestions | null;
  checksumSha256: string;
  byteCount: number;
  contentType: string;
  generatedPageChecksumSha256?: string;
  generatedPageByteCount?: number;
  semanticEntities: readonly {
    label: string;
    kind: string;
    description: string | null;
    confidence: number;
    evidencePaths: readonly string[];
  }[];
};

export function renderAffectedDocumentSourcePages(input: {
  sources: readonly AffectedDocumentSource[];
  renderSourceFilePublicIds: readonly string[];
  relations: readonly CanonicalFileRelation[];
  sourcePathRewrites?: readonly SourcePathRewrite[];
}) {
  const sources = new Map(input.sources.map((source) => [
    source.sourceFilePublicId,
    source
  ]));
  if (sources.size !== input.sources.length || input.sources.length > 10_000) {
    throw affectedPageError("source_input_invalid");
  }
  const rendered = new Set(input.renderSourceFilePublicIds);
  if (rendered.size !== input.renderSourceFilePublicIds.length
    || [...rendered].some((sourceFilePublicId) => !sources.has(sourceFilePublicId))) {
    throw affectedPageError("render_owner_invalid");
  }
  return input.sources.filter((source) => rendered.has(source.sourceFilePublicId))
    .sort((left, right) =>
    left.sourceFilePublicId.localeCompare(right.sourceFilePublicId, "en"))
    .map((source) => renderDocumentSourcePage({
      source: {
        sourceFilePublicId: source.sourceFilePublicId,
        logicalPath: source.logicalPath,
        sourceLinkBaseLogicalPath: source.sourceLinkBaseLogicalPath
          ?? source.logicalPath,
        body: source.body,
        metadata: source.metadata,
        sourceMetadata: source.sourceMetadata,
        modelSuggestions: source.modelSuggestions ?? null
      },
      related: relatedForSource(source.sourceFilePublicId, sources, input.relations),
      semanticEntities: source.semanticEntities,
      removedSourceLogicalPaths: [],
      sourcePathRewrites: input.sourcePathRewrites ?? []
    }));
}

export function documentSourcePathRewrites(
  sources: readonly AffectedDocumentSource[]
): SourcePathRewrite[] {
  return sources.flatMap((source) => {
    const prior = source.sourceLinkBaseLogicalPath ?? source.logicalPath;
    return prior === source.logicalPath ? [] : [{
      sourceFilePublicId: source.sourceFilePublicId,
      sourceLinkBase: {
        sourceFilePublicId: source.sourceFilePublicId,
        logicalPath: prior
      },
      from: `pages/${prior}`,
      to: `pages/${source.logicalPath}`,
      includeDescendants: false
    }];
  });
}

function relatedForSource(
  sourceFilePublicId: string,
  sources: ReadonlyMap<string, AffectedDocumentSource>,
  relations: readonly CanonicalFileRelation[]
) {
  return portableRelatedForSource(sourceFilePublicId, sources, relations)
    .map((item) => ({
      targetSourceFilePublicId: item.targetSourceFilePublicId,
      path: item.record.targetPath,
      title: item.record.targetTitle,
      direction: item.record.direction,
      relationKind: item.record.relationType,
      reason: item.record.reason
    }));
}

export function portableRelatedForSource(
  sourceFilePublicId: string,
  sources: ReadonlyMap<string, AffectedDocumentSource>,
  relations: readonly CanonicalFileRelation[]
) {
  const sourceRelations = relations.filter((relation) =>
    relation.firstSourceFilePublicId === sourceFilePublicId
      || relation.secondSourceFilePublicId === sourceFilePublicId);
  const presented = presentRelatedFiles({
    sourceFilePublicId,
    evidence: sourceRelations.map((relation) => ({
      relationPublicId: relation.publicId,
      targetSourceFilePublicId: relation.firstSourceFilePublicId
        === sourceFilePublicId
        ? relation.secondSourceFilePublicId : relation.firstSourceFilePublicId,
      direction: relation.evidence.sourceFilePublicId === sourceFilePublicId
        ? "outgoing" as const : "incoming" as const,
      evidencePublicId: relation.evidence.publicId,
      evidenceKind: relation.evidence.evidenceKind,
      evidence: relation.evidence.value
    }))
  });
  return presented.flatMap((item) => {
    const target = sources.get(item.targetSourceFilePublicId);
    const relation = sourceRelations.find((candidate) =>
      candidate.publicId === item.relationPublicId);
    const source = sources.get(sourceFilePublicId);
    if (!target || !relation || !source) return [];
    const record = documentRelatedProjectionRecord(
      portableProjectionRelation(relation, sources),
      source.logicalPath
    );
    return [{
      targetSourceFilePublicId: target.sourceFilePublicId,
      record: { ...record, direction: item.direction }
    }];
  });
}

export function portableProjectionRelation(
  relation: CanonicalFileRelation,
  sources: ReadonlyMap<string, AffectedDocumentSource>
): DocumentProjectionRelation {
  const evidenceSourceId = relation.evidence.sourceFilePublicId;
  const evidenceTargetId = relation.firstSourceFilePublicId === evidenceSourceId
    ? relation.secondSourceFilePublicId : relation.firstSourceFilePublicId;
  const from = sources.get(evidenceSourceId);
  const to = sources.get(evidenceTargetId);
  if (!from || !to) throw affectedPageError("relation_endpoint_missing");
  return {
    fromPath: from.logicalPath,
    toPath: to.logicalPath,
    fromTitle: from.title,
    toTitle: to.title,
    relationType: relation.relationKind,
    evidenceKind: relation.evidence.evidenceKind,
    evidenceValue: relation.evidence.value
  };
}

function affectedPageError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Affected document page error: ${code}`), { code });
}
