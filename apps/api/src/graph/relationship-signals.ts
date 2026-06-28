import type { OkfGraphNode } from "@focowiki/okf";
import { isUsefulTerm, normalizeTerm } from "./content-profile.js";

export function findSharedSpecificPhrases(source: OkfGraphNode, candidate: OkfGraphNode): string[] {
  const sourceTerms = graphNodeTerms(source);
  const candidateTerms = graphNodeTerms(candidate);
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

export function isSpecificSharedSignal(value: string): boolean {
  const normalized = normalizeTerm(value);

  if (!isUsefulTerm(normalized) || /^https?:\/\//iu.test(normalized)) {
    return false;
  }

  if (/official|source|citation|reference/iu.test(normalized)) {
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

    if (/人民代表大会常务委员会/u.test(normalized) && normalized.length > 12) {
      return false;
    }

    return true;
  }

  return normalized.length >= 5;
}

export function isStrongContentSignal(value: string): boolean {
  const normalized = normalizeTerm(value);

  if (!isSpecificSharedSignal(normalized) || isJurisdictionOnlySignal(normalized)) {
    return false;
  }

  return true;
}

function graphNodeTerms(node: OkfGraphNode): string[] {
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

function isJurisdictionOnlySignal(value: string): boolean {
  return /^[\p{Script=Han}]{1,12}(?:省|市|县|区|州|盟|旗)$/u.test(value);
}

function isCjkTerm(value: string): boolean {
  return /\p{Script=Han}/u.test(value);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
