import type { SemanticDesiredFactSet } from
  "../../semantic/domain/contracts.js";
import { documentSourceExcerpt } from "./document-source-excerpt.js";

export type SemanticFileReferenceCandidate = {
  target: string;
  confidence: number;
  sourceExcerpt: string;
  startOffset: number;
  endOffset: number;
};

export function buildSemanticFileReferenceCandidates(input: {
  body: string;
  facts: SemanticDesiredFactSet;
  maximumCandidates: number;
}): SemanticFileReferenceCandidate[] {
  const entities = new Map(input.facts.entities.map((entity) => [
    entity.publicId,
    entity
  ]));
  const evidence = new Map(input.facts.evidence.map((item) => [
    item.publicId,
    item
  ]));
  const candidates = input.facts.mentions.flatMap((mention) => {
    const entity = entities.get(mention.entityPublicId);
    const ownedEvidence = evidence.get(mention.evidencePublicId);
    if (!entity || !ownedEvidence
      || mention.sourceFilePublicId !== input.facts.sourceFilePublicId
      || mention.sourceRevisionPublicId !== input.facts.sourceRevisionPublicId
      || ownedEvidence.sourceFilePublicId !== input.facts.sourceFilePublicId
      || ownedEvidence.sourceRevisionPublicId
        !== input.facts.sourceRevisionPublicId
      || ownedEvidence.startOffset < 0
      || ownedEvidence.endOffset <= ownedEvidence.startOffset
      || ownedEvidence.endOffset > input.body.length) {
      return [];
    }
    const sourceExcerpt = input.body.slice(
      ownedEvidence.startOffset,
      ownedEvidence.endOffset
    );
    if (!normalized(sourceExcerpt).includes(normalized(entity.label))) return [];
    const boundedEvidence = boundedSemanticEvidence({
      sourceExcerpt,
      sourceStartOffset: ownedEvidence.startOffset,
      target: entity.label
    });
    if (!boundedEvidence) return [];
    return [{
      target: entity.label,
      confidence: 1,
      sourceExcerpt: boundedEvidence.sourceExcerpt,
      startOffset: boundedEvidence.startOffset,
      endOffset: boundedEvidence.endOffset
    }];
  });
  return [...new Map(candidates.map((candidate) => [
    `${normalized(candidate.target)}\0${candidate.startOffset}\0${candidate.endOffset}`,
    candidate
  ])).values()]
    .sort((left, right) => left.startOffset - right.startOffset
      || left.target.localeCompare(right.target, "en"))
    .slice(0, input.maximumCandidates);
}

function boundedSemanticEvidence(input: {
  sourceExcerpt: string;
  sourceStartOffset: number;
  target: string;
}): { sourceExcerpt: string; startOffset: number; endOffset: number } | null {
  const directTargetOffset = input.sourceExcerpt.indexOf(input.target);
  const targetOffset = directTargetOffset >= 0
    ? directTargetOffset
    : input.sourceExcerpt.toLocaleLowerCase("en-US")
      .indexOf(input.target.toLocaleLowerCase("en-US"));
  if (targetOffset < 0) return null;
  const requestedStart = Math.max(0, targetOffset - 300);
  const windowStart = startsInsideSurrogatePair(input.sourceExcerpt, requestedStart)
    ? requestedStart - 1 : requestedStart;
  const sourceExcerpt = documentSourceExcerpt(input.sourceExcerpt.slice(windowStart));
  if (!normalized(sourceExcerpt).includes(normalized(input.target))) return null;
  const startOffset = input.sourceStartOffset + windowStart;
  return {
    sourceExcerpt,
    startOffset,
    endOffset: startOffset + sourceExcerpt.length
  };
}

function startsInsideSurrogatePair(value: string, offset: number): boolean {
  if (offset <= 0 || offset >= value.length) return false;
  const current = value.charCodeAt(offset);
  const previous = value.charCodeAt(offset - 1);
  return current >= 0xdc00 && current <= 0xdfff
    && previous >= 0xd800 && previous <= 0xdbff;
}

function normalized(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US")
    .replace(/\s+/gu, " ");
}
