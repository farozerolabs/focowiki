import { createHash } from "node:crypto";
import type { LexicalTokenizer } from "./ports/lexical-tokenizer.js";
import type {
  SearchProjectionDocumentRecord,
  SearchProjectionRepository
} from "./ports/search-projection-repository.js";
import { generatedPagePath } from "../domain/source-path.js";
import { buildBodySearchDocument } from "../search/body-search-document.js";

export async function persistBodySearchProjection(input: {
  repository: SearchProjectionRepository;
  tokenizer: LexicalTokenizer;
  knowledgeBaseId: string;
  sourceFileId: string;
  sourceRevisionId: string;
  relativePath: string;
  title: string;
  summary: string | null;
  body: string;
  completedAt: string;
}): Promise<SearchProjectionDocumentRecord> {
  const sourceBodyChecksumSha256 = createHash("sha256")
    .update(input.body, "utf8")
    .digest("hex");
  const result = await input.repository.persistDocument({
    document: buildBodySearchDocument({
      knowledgeBaseId: input.knowledgeBaseId,
      sourceFileId: input.sourceFileId,
      sourceRevisionId: input.sourceRevisionId,
      sourceBodyChecksumSha256,
      title: input.title,
      logicalPath: generatedPagePath(input.relativePath),
      summary: input.summary,
      body: input.body,
      tokenizer: input.tokenizer
    }),
    completedAt: input.completedAt
  });
  return result.document;
}
