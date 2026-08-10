import { createHash } from "node:crypto";
import type { DatabaseClient } from "../../db/client.js";
import type {
  SemanticCommunitySummaryArtifactIdentity,
  SemanticCommunitySummaryArtifactPort
} from "../application/community-summary-artifacts.js";

export function createPostgresCommunitySummaryArtifactRepository(
  sql: DatabaseClient
): SemanticCommunitySummaryArtifactPort {
  return {
    async find(input) {
      assertIdentity(input);
      const rows = await sql<Array<{ summary: string }>>`
        SELECT summary
        FROM focowiki.semantic_community_summary_artifacts
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND input_sha256 = ${input.inputSha256}
          AND model_configuration_public_id = ${input.modelConfigurationPublicId}
          AND model_configuration_revision = ${input.modelConfigurationRevision}
          AND prompt_contract_version = ${input.promptContractVersion}
        LIMIT 1
      `;
      return rows[0]?.summary ?? null;
    },
    async put(input) {
      assertIdentity(input);
      if (!input.summary.trim() || Buffer.byteLength(input.summary) > 65_536) {
        throw artifactError("invalid_summary");
      }
      const identitySha256 = hash(
        input.knowledgeBaseId,
        input.inputSha256,
        input.modelConfigurationPublicId,
        String(input.modelConfigurationRevision),
        input.promptContractVersion
      );
      await sql`
        INSERT INTO focowiki.semantic_community_summary_artifacts (
          knowledge_base_id, public_id, input_sha256,
          model_configuration_public_id, model_configuration_revision,
          prompt_contract_version, summary, summary_sha256
        ) VALUES (
          ${input.knowledgeBaseId}, ${`community-summary-${identitySha256}`},
          ${input.inputSha256}, ${input.modelConfigurationPublicId},
          ${input.modelConfigurationRevision}, ${input.promptContractVersion},
          ${input.summary.trim()}, ${hash(input.summary.trim())}
        )
        ON CONFLICT (
          knowledge_base_id, input_sha256, model_configuration_public_id,
          model_configuration_revision, prompt_contract_version
        ) DO NOTHING
      `;
    }
  };
}

function assertIdentity(input: SemanticCommunitySummaryArtifactIdentity): void {
  if (!input.knowledgeBaseId || input.knowledgeBaseId.length > 255
    || !/^[0-9a-f]{64}$/u.test(input.inputSha256)
    || !input.modelConfigurationPublicId
    || input.modelConfigurationPublicId.length > 255
    || !Number.isSafeInteger(input.modelConfigurationRevision)
    || input.modelConfigurationRevision < 1
    || !input.promptContractVersion
    || input.promptContractVersion.length > 255) {
    throw artifactError("invalid_identity");
  }
}

function hash(...values: string[]): string {
  return createHash("sha256").update(values.join("\u001f")).digest("hex");
}

function artifactError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Semantic community summary artifact error: ${code}`),
    { code }
  );
}
