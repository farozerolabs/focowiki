import { isLowInformationSharedGraphTerm, type OkfGraphNode } from "@focowiki/okf";
import { isUsefulTerm, normalizeTerm } from "./content-profile.js";

export function findSharedSpecificPhrases(source: OkfGraphNode, candidate: OkfGraphNode): string[] {
  const sourceTerms = listStrongGraphNodeTerms(source);
  const candidateTerms = listStrongGraphNodeTerms(candidate);
  const matches: string[] = [];

  for (const sourceTerm of sourceTerms) {
    for (const candidateTerm of candidateTerms) {
      const match = matchSpecificPhrase(sourceTerm, candidateTerm);

      if (match) {
        matches.push(match);
      }
    }
  }

  return unique(matches).sort((left, right) => right.length - left.length || left.localeCompare(right)).slice(0, 16);
}

export function listStrongGraphNodeTerms(node: OkfGraphNode): string[] {
  return unique([
    node.title,
    ...(node.subjects ?? []),
    ...(node.entities ?? []),
    ...(node.keywords ?? []),
    ...(node.headings ?? []),
    ...(node.relationshipHints ?? [])
  ])
    .map(normalizeTerm)
    .filter(isStrongContentSignal);
}

export function isSpecificSharedSignal(value: string): boolean {
  const normalized = normalizeTerm(value);

  if (!isUsefulTerm(normalized) || isLowInformationSharedGraphTerm(normalized) || /^https?:\/\//iu.test(normalized)) {
    return false;
  }

  if (/official|source|citation|reference/iu.test(normalized)) {
    return false;
  }

  if (hasGenericBoilerplateShape(normalized)) {
    return false;
  }

  if (/^\d+$/u.test(normalized) || /^[年月日号第届次条款章节]+$/u.test(normalized)) {
    return false;
  }

  if (/\p{Script=Han}/u.test(normalized)) {
    if (normalized.length < 3 || normalized.length > 30) {
      return false;
    }

    if (/^(日|年|月|第|号)/u.test(normalized)) {
      return false;
    }

    return true;
  }

  return normalized.length >= 5;
}

export function isStrongContentSignal(value: string): boolean {
  const normalized = normalizeTerm(value);

  if (!isSpecificSharedSignal(normalized)) {
    return false;
  }

  if (isCjkTerm(normalized) && normalized.replace(/\s+/gu, "").length < 4) {
    return false;
  }

  return true;
}

function matchSpecificPhrase(left: string, right: string): string | null {
  const normalizedLeft = normalizeTerm(left);
  const normalizedRight = normalizeTerm(right);

  if (!isStrongContentSignal(normalizedLeft) || !isStrongContentSignal(normalizedRight)) {
    return null;
  }

  if (normalizedLeft === normalizedRight) {
    return normalizedLeft;
  }

  if (!isCjkTerm(normalizedLeft) || !isCjkTerm(normalizedRight)) {
    return null;
  }

  const shorter = normalizedLeft.length <= normalizedRight.length ? normalizedLeft : normalizedRight;
  const longer = shorter === normalizedLeft ? normalizedRight : normalizedLeft;

  if (shorter.length >= 4 && longer.includes(shorter)) {
    return shorter;
  }

  return null;
}

function isCjkTerm(value: string): boolean {
  return /\p{Script=Han}/u.test(value);
}

function hasGenericBoilerplateShape(value: string): boolean {
  if (!/\p{Script=Han}/u.test(value)) {
    return false;
  }

  return /^(?:本|该|此)(?:文|文件|文档|页面|资料|章节)?|^(?:为了|根据|有关|相关|结合|制定)/u.test(value);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
