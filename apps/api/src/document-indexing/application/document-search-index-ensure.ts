import type {
  SearchProviderIndexDefinition,
  SearchProviderRuntime
} from "../../application/ports/search-provider-runtime.js";
import type { RuntimeSearchSettings } from
  "../../runtime-settings/types.js";
import { createStorageVnextSearchSettingsChecksum } from
  "../../storage-vnext/search/index-identity.js";

export async function ensureDocumentSearchIndex(input: {
  provider: SearchProviderRuntime;
  indexUid: string;
  definition: SearchProviderIndexDefinition;
  settings: RuntimeSearchSettings;
  signal: AbortSignal;
  awaitReceipt(
    receipt: Awaited<ReturnType<SearchProviderRuntime["admin"]["createIndex"]>>
  ): Promise<void>;
}): Promise<void> {
  assertInput(input);
  let index = await input.provider.admin.getIndex({ indexUid: input.indexUid });
  if (!index) {
    try {
      await input.awaitReceipt(await input.provider.admin.createIndex({
        indexUid: input.indexUid,
        definition: input.definition
      }));
    } catch (error) {
      index = await input.provider.admin.getIndex({ indexUid: input.indexUid });
      if (!index) throw error;
    }
  }
  index ??= await input.provider.admin.getIndex({ indexUid: input.indexUid });
  if (!index || index.primaryKey !== input.definition.primaryKey) {
    throw ensureError("search_index_primary_key_conflict");
  }
  const current = await input.provider.admin.getIndexDefinition({
    indexUid: input.indexUid
  });
  if (!current || createStorageVnextSearchSettingsChecksum(current)
    !== createStorageVnextSearchSettingsChecksum(input.definition)) {
    await input.awaitReceipt(await input.provider.admin.updateIndexDefinition({
      indexUid: input.indexUid,
      definition: input.definition
    }));
  }
  const applied = await input.provider.admin.getIndexDefinition({
    indexUid: input.indexUid
  });
  if (!applied || createStorageVnextSearchSettingsChecksum(applied)
    !== createStorageVnextSearchSettingsChecksum(input.definition)) {
    throw ensureError("search_index_settings_conflict");
  }
}

function assertInput(input: {
  indexUid: string;
  signal: AbortSignal;
}): void {
  if (!input.indexUid || Buffer.byteLength(input.indexUid, "utf8") > 1_024) {
    throw ensureError("search_index_identity_invalid");
  }
  if (input.signal.aborted) throw input.signal.reason;
}

function ensureError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document search index error: ${code}`), { code });
}
