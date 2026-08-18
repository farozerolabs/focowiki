import { createHash } from "node:crypto";
import {
  normalizeSourceRelativePath,
  resolveSourceMarkdownLinkDestination
} from "@focowiki/okf";
import type { DocumentReferenceProfile } from
  "../domain/document-source-profiles.js";
import type { FileRelationEvidenceKind } from "../domain/file-relation.js";

export type DocumentRelationCandidate = {
  referenceKind: FileRelationEvidenceKind;
  rawTarget: string;
  normalizedTargetKey: string;
  evidenceChecksumSha256: string;
  evidence: Readonly<Record<string, unknown>>;
};

type SemanticCandidate = {
  target: string;
  confidence: number;
  sourceExcerpt: string;
  startOffset: number;
  endOffset: number;
  evidenceTerms?: readonly string[];
  relationType?: string;
  reason?: string;
  source?: "deterministic" | "model_confirmed";
};

const GENERIC_IDENTITIES = new Set([
  "document", "file", "page", "guide", "overview", "introduction",
  "knowledge base", "documentation", "general", "content"
]);

export function buildDocumentRelationCandidates(input: {
  sourceLogicalPath: string;
  references: readonly DocumentReferenceProfile["references"][number][];
  metadata: Readonly<Record<string, unknown>>;
  semanticCandidates: readonly SemanticCandidate[];
  candidateLimit?: number;
  genericPhraseThreshold?: number;
}): DocumentRelationCandidate[] {
  const candidateLimit = input.candidateLimit ?? 512;
  const genericPhraseThreshold = input.genericPhraseThreshold ?? 2;
  const candidates: DocumentRelationCandidate[] = [];
  for (const reference of input.references.slice(0, candidateLimit)) {
    const key = pathKey(reference.resolvedTarget);
    if (!key) continue;
    candidates.push(candidate("markdown_link", reference.rawTarget, key, {
      label: reference.label,
      rawTarget: reference.rawTarget,
      resolvedTarget: reference.resolvedTarget,
      startOffset: reference.startOffset,
      endOffset: reference.endOffset
    }));
  }
  for (const rawTarget of metadataReferences(input.metadata)
    .slice(0, candidateLimit)) {
    const key = referenceKey(
      rawTarget,
      input.sourceLogicalPath,
      genericPhraseThreshold
    );
    if (!key) continue;
    candidates.push(candidate("okf_metadata", rawTarget, key, { rawTarget }));
  }
  for (const semantic of input.semanticCandidates.slice(0, candidateLimit)) {
    const normalizedTargetKey = referenceKey(
      semantic.target,
      input.sourceLogicalPath,
      genericPhraseThreshold
    );
    const evidenceTerms = semantic.evidenceTerms?.length
      ? semantic.evidenceTerms : [semantic.target];
    const evidenceGrounded = evidenceTerms.some((term) => {
      const normalizedTerm = normalizeIdentity(term);
      return isSpecificIdentity(normalizedTerm, genericPhraseThreshold)
        && normalizeIdentity(semantic.sourceExcerpt).includes(normalizedTerm);
    });
    const minimumConfidence = semantic.source === "model_confirmed" ? 0.6 : 0.85;
    if (!normalizedTargetKey
      || semantic.confidence < minimumConfidence
      || semantic.startOffset < 0 || semantic.endOffset <= semantic.startOffset
      || !evidenceGrounded) {
      continue;
    }
    candidates.push(candidate("semantic", semantic.target, normalizedTargetKey, {
      target: semantic.target,
      confidence: semantic.confidence,
      sourceExcerpt: semantic.sourceExcerpt,
      startOffset: semantic.startOffset,
      endOffset: semantic.endOffset,
      evidenceTerms: [...evidenceTerms].slice(0, 16),
      ...(semantic.relationType ? { relationType: semantic.relationType } : {}),
      ...(semantic.reason ? { reason: semantic.reason } : {}),
      ...(semantic.source ? { source: semantic.source } : {})
    }));
  }
  return deduplicate(candidates).slice(0, candidateLimit);
}

export function buildDocumentIdentityKeys(input: {
  logicalPath: string;
  title: string;
  aliases: readonly string[];
  genericPhraseThreshold?: number;
}): string[] {
  const path = normalizeSourceRelativePath(input.logicalPath);
  const genericPhraseThreshold = input.genericPhraseThreshold ?? 2;
  const aliases = [input.title, ...input.aliases]
    .map(normalizeIdentity)
    .filter((value) => isSpecificIdentity(value, genericPhraseThreshold))
    .map((value) => `alias:${value}`);
  return [...new Set([
    `path:${path.pathKey}`,
    `alias:${normalizeIdentity(path.name.replace(/\.md$/iu, ""))}`,
    ...aliases
  ])].slice(0, 256);
}

function metadataReferences(metadata: Readonly<Record<string, unknown>>): string[] {
  const values: unknown[] = [];
  for (const key of ["references", "related", "links", "see_also", "seeAlso"]) {
    const value = metadata[key];
    if (typeof value === "string") values.push(value);
    else if (Array.isArray(value)) values.push(...value);
  }
  return values.filter((value): value is string => typeof value === "string")
    .map((value) => value.trim()).filter(Boolean);
}

function referenceKey(
  rawTarget: string,
  sourceLogicalPath: string,
  genericPhraseThreshold: number
): string | null {
  const direct = pathKey(rawTarget);
  if (direct) return direct;
  const normalized = normalizeIdentity(rawTarget);
  if (!isSpecificIdentity(normalized, genericPhraseThreshold)) return null;
  if (/\.md(?:[#?].*)?$/iu.test(rawTarget)) {
    try {
      return pathKey(resolveSourceMarkdownLinkDestination(
        rawTarget,
        sourceLogicalPath
      ));
    } catch {
      return null;
    }
  }
  return `alias:${normalized}`;
}

function pathKey(value: string): string | null {
  let target = stripTarget(value);
  if (target.startsWith("/pages/")) target = target.slice(7);
  else if (target.startsWith("pages/")) target = target.slice(6);
  if (!target.toLowerCase().endsWith(".md")) return null;
  try {
    return `path:${normalizeSourceRelativePath(target).pathKey}`;
  } catch {
    return null;
  }
}

function stripTarget(value: string): string {
  return value.trim().replace(/^<|>$/gu, "").split(/[?#]/u, 1)[0] ?? "";
}

function normalizeIdentity(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US")
    .replace(/\s+/gu, " ").slice(0, 512);
}

function isSpecificIdentity(value: string, minimumLength: number): boolean {
  return Boolean(value)
    && !GENERIC_IDENTITIES.has(value)
    && [...value].length >= minimumLength;
}

function candidate(
  kind: FileRelationEvidenceKind,
  rawTarget: string,
  normalizedTargetKey: string,
  evidence: Readonly<Record<string, unknown>>
): DocumentRelationCandidate {
  const evidenceChecksumSha256 = createHash("sha256")
    .update(JSON.stringify(evidence)).digest("hex");
  return {
    referenceKind: kind,
    rawTarget,
    normalizedTargetKey,
    evidenceChecksumSha256,
    evidence
  };
}

function deduplicate(
  candidates: readonly DocumentRelationCandidate[]
): DocumentRelationCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((item) => {
    const identity = `${item.referenceKind}\0${item.normalizedTargetKey}\0${item.evidenceChecksumSha256}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}
