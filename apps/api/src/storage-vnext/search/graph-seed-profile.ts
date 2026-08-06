import type { StorageVnextGraphNodeFact } from "../graph/ports.js";
import type {
  StorageVnextPublicDocument,
  StorageVnextPublicValue
} from "../shared/types.js";

const PROFILE_TERM_KEYS = [
  "subjects",
  "keywords",
  "entities",
  "explicitReferences",
  "relationshipHints",
  "definitions",
  "processHints",
  "versionHints",
  "evidencePhrases"
] as const;
const MAXIMUM_GRAPH_SEED_TERMS = 100;

export function readStorageVnextGraphSeedProfile(node: StorageVnextGraphNodeFact): {
  searchText: string;
  rankingTerms: string[];
} {
  const profile = readDocument(node.metadata.contentProfile);
  const terms = unique([
    node.kind,
    ...readStringList(node.metadata.tags),
    ...PROFILE_TERM_KEYS.flatMap((key) => readStringList(profile?.[key]))
  ]).slice(0, MAXIMUM_GRAPH_SEED_TERMS);
  return {
    searchText: unique([node.label, node.kind, ...terms]).join(" "),
    rankingTerms: terms
  };
}

function readStringList(value: StorageVnextPublicValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => typeof item === "string" ? [item] : []);
}

function readDocument(value: StorageVnextPublicValue | undefined):
StorageVnextPublicDocument | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as StorageVnextPublicDocument;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
