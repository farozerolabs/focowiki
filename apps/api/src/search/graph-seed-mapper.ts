import { createHash } from "node:crypto";

export const SEARCH_GRAPH_SEED_SCHEMA_VERSION = "graph-seed-v1";

export type GraphSeedDocument = {
  id: string;
  knowledgeBaseId: string;
  sourceFileId: string;
  sourceRevisionId: string;
  logicalPath: string;
  title: string;
  sourceUrl: string | null;
  lexicalText: string;
  exactTerms: string[];
  phraseTerms: string[];
  explicitReferences: string[];
  fingerprint: string;
  visibleFromEpoch: number;
  visibleUntilEpoch: number | null;
  schemaVersion: string;
};

export function mapGraphSeedDocument(input: Omit<
  GraphSeedDocument,
  "id" | "schemaVersion"
>): GraphSeedDocument {
  return {
    id: createHash("sha256")
      .update([
        SEARCH_GRAPH_SEED_SCHEMA_VERSION,
        input.knowledgeBaseId,
        input.sourceFileId,
        input.sourceRevisionId,
        input.logicalPath,
        input.fingerprint
      ].join("\u0000"))
      .digest("hex"),
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFileId: input.sourceFileId,
    sourceRevisionId: input.sourceRevisionId,
    logicalPath: input.logicalPath,
    title: input.title,
    sourceUrl: input.sourceUrl,
    lexicalText: input.lexicalText,
    exactTerms: stableUnique(input.exactTerms),
    phraseTerms: stableUnique(input.phraseTerms),
    explicitReferences: stableUnique(input.explicitReferences),
    fingerprint: input.fingerprint,
    visibleFromEpoch: input.visibleFromEpoch,
    visibleUntilEpoch: input.visibleUntilEpoch,
    schemaVersion: SEARCH_GRAPH_SEED_SCHEMA_VERSION
  };
}

function stableUnique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}
