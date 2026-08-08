import { tokenizeBoundedDocument } from
  "../../application/bounded-tokenization.js";
import type { LexicalTokenizer } from
  "../../application/ports/lexical-tokenizer.js";
import type { SearchProviderIndexDefinition } from
  "../../application/ports/search-provider-runtime.js";
import { SearchProviderError } from
  "../../application/ports/search-provider-runtime.js";
import { parseStorageVnextSearchDocument } from
  "../../storage-vnext/search/document-codec.js";
import type { StorageVnextSearchDocument } from
  "../../storage-vnext/search/documents.js";

const MAXIMUM_HEADING_ANCESTORS = 256;
const MAXIMUM_HEADING_BYTES = 4_096;
const MAXIMUM_RANKING_TERMS = 1_000;
const MAXIMUM_JIEBA_TERMS = 2_000;

const CONTENT_DOCUMENT_FIELDS = new Set([
  "id", "schemaVersion", "documentKind", "contentKind", "knowledgeBaseId",
  "sourceFilePublicId", "sourceRevisionPublicId", "logicalPath", "fileKind",
  "title", "segmentOrdinal", "headingAncestors", "searchText", "okfSignals"
]);
const GRAPH_DOCUMENT_FIELDS = new Set([
  "id", "schemaVersion", "documentKind", "knowledgeBaseId",
  "sourceFilePublicId", "sourceRevisionPublicId", "logicalPath", "title",
  "searchText", "rankingTerms", "okfSignals"
]);

export function createOpenSearchIndexBody(input: {
  definition: SearchProviderIndexDefinition;
  tokenizerContractVersion: string;
}) {
  assertDefinition(input.definition);
  if (!input.tokenizerContractVersion) throw mappingError();
  return {
    settings: {
      index: {
        max_result_window: input.definition.maximumTotalHits
      },
      analysis: {
        analyzer: {
          focowiki_jieba_evidence: {
            type: "custom",
            tokenizer: "whitespace",
            filter: ["lowercase"]
          }
        }
      }
    },
    mappings: {
      dynamic: "strict",
      _meta: {
        provider: "opensearch",
        tokenizerContractVersion: input.tokenizerContractVersion,
        definition: structuredClone(input.definition)
      },
      properties: {
        id: keyword(),
        schemaVersion: keyword(),
        documentKind: keyword(),
        contentKind: keyword(),
        knowledgeBaseId: keyword(),
        sourceFilePublicId: keyword(),
        sourceRevisionPublicId: keyword(),
        logicalPath: standardText(),
        fileKind: keyword(),
        title: standardText(),
        segmentOrdinal: { type: "integer" },
        headingAncestors: standardText(),
        searchText: standardText(),
        rankingTerms: standardText(),
        okfSignals: {
          type: "object",
          dynamic: "strict",
          properties: {
            status: keyword(),
            trustTier: keyword(),
            staleAfterEpochDay: { type: "long" },
            generatedAtEpochMs: { type: "long" },
            latestVerifiedAtEpochMs: { type: "long" },
            sourceCount: { type: "integer" }
          }
        },
        visible: { type: "boolean" },
        _focowikiJiebaText: {
          type: "text",
          analyzer: "focowiki_jieba_evidence"
        },
        _focowikiTitleExact: keyword(),
        _focowikiPathExact: keyword()
      }
    }
  } as const;
}

export function serializeOpenSearchDocument(input: {
  document: StorageVnextSearchDocument;
  tokenizer: LexicalTokenizer;
}): {
  _id: string;
  _source: Record<string, unknown>;
} {
  if (!input.tokenizer.contractVersion) throw mappingError();
  const record = input.document as unknown as Record<string, unknown>;
  assertKnownFields(record);
  let document: StorageVnextSearchDocument;
  try {
    document = parseStorageVnextSearchDocument(record);
  } catch {
    throw mappingError();
  }
  assertBoundedMetadata(document);
  const jiebaInput = [
    document.title ?? "",
    document.logicalPath,
    ...(document.documentKind === "content" ? document.headingAncestors : []),
    document.searchText,
    ...(document.documentKind === "graph_seed" ? document.rankingTerms : [])
  ].join("\n");
  let terms: string[];
  try {
    terms = tokenizeBoundedDocument(
      input.tokenizer,
      jiebaInput,
      MAXIMUM_JIEBA_TERMS
    );
  } catch {
    throw mappingError();
  }
  return {
    _id: document.id,
    _source: {
      ...document,
      _focowikiJiebaText: terms.join(" "),
      _focowikiTitleExact: normalizeExact(document.title ?? ""),
      _focowikiPathExact: normalizeExact(document.logicalPath)
    }
  };
}

function assertKnownFields(document: Record<string, unknown>): void {
  const allowed = document.documentKind === "content"
    ? CONTENT_DOCUMENT_FIELDS
    : document.documentKind === "graph_seed"
      ? GRAPH_DOCUMENT_FIELDS
      : null;
  if (!allowed || Object.keys(document).some((field) => !allowed.has(field))) {
    throw mappingError();
  }
}

function assertBoundedMetadata(document: StorageVnextSearchDocument): void {
  if (document.documentKind === "content" && (
    document.headingAncestors.length > MAXIMUM_HEADING_ANCESTORS
    || document.headingAncestors.some((heading) =>
      Buffer.byteLength(heading, "utf8") > MAXIMUM_HEADING_BYTES
    )
  )) throw mappingError();
  if (
    document.documentKind === "graph_seed"
    && document.rankingTerms.length > MAXIMUM_RANKING_TERMS
  ) throw mappingError();
}

function assertDefinition(definition: SearchProviderIndexDefinition): void {
  if (
    definition.primaryKey !== "id"
    || definition.distinctAttribute !== "sourceFilePublicId"
    || !Number.isSafeInteger(definition.maximumTotalHits)
    || definition.maximumTotalHits < 1
  ) throw mappingError();
}

function keyword() {
  return { type: "keyword" as const };
}

function standardText() {
  return { type: "text" as const, analyzer: "standard" as const };
}

function normalizeExact(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function mappingError(): SearchProviderError {
  return new SearchProviderError("SEARCH_ENGINE_MAPPING_INVALID", false);
}
