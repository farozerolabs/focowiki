import type { LexicalRebuildRepository } from "../application/ports/lexical-rebuild-repository.js";
import type { LexicalTokenizer } from "../application/ports/lexical-tokenizer.js";
import { CONTENT_PROFILE_VERSION } from "../graph/content-profile.js";
import { GRAPH_LEXICAL_PROJECTION_VERSION } from "../graph/graph-term-document.js";
import { BODY_SEARCH_SCHEMA_VERSION } from "../search/body-search-document.js";
import { BODY_SEGMENTATION_VERSION } from "../search/body-segmentation.js";

export function bootstrapLexicalRebuildWork(input: {
  rebuilds: LexicalRebuildRepository;
  tokenizer: LexicalTokenizer;
  now: string;
}): Promise<number> {
  return input.rebuilds.bootstrap({
    searchSchemaVersion: BODY_SEARCH_SCHEMA_VERSION,
    tokenizerContractVersion: input.tokenizer.contractVersion,
    segmentationVersion: BODY_SEGMENTATION_VERSION,
    contentProfileVersion: CONTENT_PROFILE_VERSION,
    graphLexicalProjectionVersion: GRAPH_LEXICAL_PROJECTION_VERSION,
    now: input.now
  });
}
