import {
  isLowInformationSharedGraphTerm,
  type OkfGraphNode
} from "@focowiki/okf";
import { isUsefulTerm, normalizeTerm } from "./content-profile.js";
import {
  isSpecificSharedSignal,
  isStrongContentSignal
} from "./relationship-signals.js";
import {
  normalizePublicPath,
  readContentProfileStringArray,
  stripMarkdownExtension
} from "./graph-utils.js";

const VERSION_METADATA_KEYS = [
  "version",
  "timestamp",
  "publishedAt",
  "updatedAt",
  "publicationDate",
  "status"
] as const;

export type GraphEdgeNormalizationCache = ReturnType<
  typeof createGraphEdgeNormalizationCache
>;

export type GraphEdgeNodeProfile = {
  node: OkfGraphNode;
  normalizedTitle: string;
  compactTitle: string;
  normalizedPath: string;
  normalizedStem: string;
  strongTerms: string[];
  compactStrongTerms: Set<string>;
  normalizedStrongTerms: Set<string>;
  subjects: string[];
  entities: string[];
  keywords: string[];
  definitions: string[];
  processHints: string[];
  versionHints: string[];
  normalizedVersionHints: string[];
  compactVersionHints: string[];
  explicitReferences: Array<{
    value: string;
    normalizedPath: string;
    normalizedText: string;
  }>;
  versionMetadata: ReadonlyMap<string, string>;
};

export function createGraphEdgeNormalizationCache() {
  const terms = new Map<string, string>();
  const searchTexts = new Map<string, string>();
  const compactTexts = new Map<string, string>();
  const usefulTerms = new Map<string, boolean>();
  const specificSignals = new Map<string, boolean>();
  const strongSignals = new Map<string, boolean>();
  const lowInformationTerms = new Map<string, boolean>();

  const term = (value: string): string => cached(terms, value, () => normalizeTerm(value));
  const searchText = (value: string): string => cached(searchTexts, value, () =>
    term(value).replace(/[^\p{L}\p{N}]+/gu, " ").trim());
  const compactText = (value: string): string => cached(compactTexts, value, () =>
    searchText(value).replace(/\s+/gu, ""));
  const useful = (value: string): boolean => {
    const normalized = term(value);
    return cached(usefulTerms, normalized, () => isUsefulTerm(normalized));
  };
  const specific = (value: string): boolean => {
    const normalized = term(value);
    return cached(specificSignals, normalized, () => isSpecificSharedSignal(normalized));
  };
  const strong = (value: string): boolean => {
    const normalized = term(value);
    return cached(strongSignals, normalized, () => isStrongContentSignal(normalized));
  };
  const lowInformation = (value: string): boolean => {
    const normalized = compactText(value);
    return cached(lowInformationTerms, normalized, () =>
      isLowInformationSharedGraphTerm(normalized));
  };

  return {
    term,
    searchText,
    compactText,
    useful,
    specific,
    strong,
    lowInformation
  };
}

export function createGraphEdgeNodeProfile(
  node: OkfGraphNode,
  normalization: GraphEdgeNormalizationCache
): GraphEdgeNodeProfile {
  const versionHints = readContentProfileStringArray(node, "versionHints");
  const normalizedVersionHints = unique(
    versionHints.map(normalization.searchText).filter(Boolean)
  );
  const strongTerms = unique([
    node.title,
    ...(node.subjects ?? []),
    ...(node.entities ?? []),
    ...(node.keywords ?? []),
    ...(node.headings ?? []),
    ...(node.relationshipHints ?? [])
  ])
    .map(normalization.term)
    .filter(normalization.strong);
  const compactStrongTerms = new Set(
    strongTerms.map(normalization.compactText).filter(Boolean)
  );
  const normalizedTitle = normalization.searchText(node.title);

  return {
    node,
    normalizedTitle,
    compactTitle: normalization.compactText(node.title),
    normalizedPath: normalizePublicPath(node.path),
    normalizedStem: normalization.searchText(
      stripMarkdownExtension(node.path.split("/").at(-1) ?? node.title)
    ),
    strongTerms,
    compactStrongTerms,
    normalizedStrongTerms: new Set(
      [...compactStrongTerms].filter((value) =>
        normalization.strong(value) && !normalization.lowInformation(value))
    ),
    subjects: normalizeUsefulTerms(node.subjects ?? [], normalization),
    entities: normalizeUsefulTerms(node.entities ?? [], normalization),
    keywords: normalizeUsefulTerms(node.keywords ?? [], normalization),
    definitions: normalizeUsefulTerms(
      readContentProfileStringArray(node, "definitions"),
      normalization
    ),
    processHints: normalizeUsefulTerms(
      readContentProfileStringArray(node, "processHints"),
      normalization
    ),
    versionHints,
    normalizedVersionHints,
    compactVersionHints: normalizedVersionHints.map(normalization.compactText),
    explicitReferences: (node.explicitReferences ?? []).map((reference) => ({
      value: reference,
      normalizedPath: normalizePublicPath(reference),
      normalizedText: normalization.searchText(reference)
    })),
    versionMetadata: new Map(VERSION_METADATA_KEYS.map((key) => [
      key,
      normalizeVersionMetadataValue(node.metadata?.[key], normalization)
    ]))
  };
}

export function intersectGraphEdgeProfileTerms(
  left: readonly string[],
  right: readonly string[]
): string[] {
  const rightValues = new Set(right);
  return left.filter((value) => rightValues.has(value));
}

function normalizeUsefulTerms(
  values: readonly string[],
  normalization: GraphEdgeNormalizationCache
): string[] {
  return unique(values.map(normalization.term).filter(normalization.useful));
}

function normalizeVersionMetadataValue(
  value: unknown,
  normalization: GraphEdgeNormalizationCache
): string {
  return typeof value === "string" || typeof value === "number"
    ? normalization.searchText(String(value))
    : "";
}

function cached<T>(
  cache: Map<string, T>,
  key: string,
  create: () => T
): T {
  const current = cache.get(key);
  if (current !== undefined) return current;
  const value = create();
  cache.set(key, value);
  return value;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
