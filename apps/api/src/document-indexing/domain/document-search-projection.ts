import { createHash } from "node:crypto";
import type { SearchProviderKind } from
  "../../application/ports/search-provider-runtime.js";
import type { SearchProviderIndexDefinition } from
  "../../application/ports/search-provider-runtime.js";
import { createStorageVnextSearchIndexUid } from
  "../../storage-vnext/search/index-identity.js";
import { createStorageVnextSearchSettingsChecksum } from
  "../../storage-vnext/search/index-identity.js";
import { createStorageVnextSearchSchemaChecksum } from
  "../../storage-vnext/search/settings.js";

export type DocumentSearchProjectionBootstrap = {
  publicId: string;
  providerKind: SearchProviderKind;
  providerIndexUid: string;
  schemaChecksumSha256: string;
  settingsChecksumSha256: string;
};

export function createDocumentSearchProjectionBootstrap(input: {
  knowledgeBaseId: string;
  providerKind: SearchProviderKind;
  indexUidPrefix: string;
  definition: SearchProviderIndexDefinition;
}): DocumentSearchProjectionBootstrap {
  assertIdentity(input.knowledgeBaseId);
  const fingerprint = digest(JSON.stringify([
    "document-search-projection-v1",
    input.knowledgeBaseId,
    input.providerKind,
    createStorageVnextSearchSchemaChecksum(),
    createStorageVnextSearchSettingsChecksum(input.definition)
  ]));
  const publicId = `search-projection-${fingerprint}`;
  return {
    publicId,
    providerKind: input.providerKind,
    providerIndexUid: createStorageVnextSearchIndexUid({
      indexUidPrefix: input.indexUidPrefix,
      knowledgeBaseId: input.knowledgeBaseId,
      projectionPublicId: publicId,
      incarnationPublicId: "document-indexing-v1"
    }),
    schemaChecksumSha256: createStorageVnextSearchSchemaChecksum(),
    settingsChecksumSha256:
      createStorageVnextSearchSettingsChecksum(input.definition)
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertIdentity(value: string): void {
  if (!value || Buffer.byteLength(value, "utf8") > 255) {
    throw new Error("Document search projection identity is invalid");
  }
}
