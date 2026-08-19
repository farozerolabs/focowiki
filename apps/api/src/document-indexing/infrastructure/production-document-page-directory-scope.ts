import { buildDocumentPageDirectoryScopeResources } from
  "../application/document-page-term-projection.js";
import type { createPostgresDocumentMachineProjectionReader } from
  "./postgres-document-machine-projection-reader.js";
import { scopeRenderError } from
  "./production-document-scope-renderer-support.js";

export type DocumentPageIntegrityOverride = Readonly<{
  path: string;
  checksumSha256: string;
  byteCount: number;
}>;

export async function projectDocumentPageDirectoryScope(input: {
  machineProjection: ReturnType<typeof createPostgresDocumentMachineProjectionReader>;
  knowledgeBaseId: string;
  scopePath: string;
  includedSourceRevisionPublicIds: readonly string[];
  excludedActiveSourceFilePublicIds: readonly string[];
  pageIntegrityOverrides: readonly DocumentPageIntegrityOverride[];
  maximumRecordsPerShard: number;
  maximumShardBytes: number;
}) {
  const state = await input.machineProjection.readDocumentDirectoryState({
    knowledgeBaseId: input.knowledgeBaseId,
    scopePath: input.scopePath,
    includedSourceRevisionPublicIds: input.includedSourceRevisionPublicIds,
    excludedActiveSourceFilePublicIds: input.excludedActiveSourceFilePublicIds
  });
  const integrityByPath = normalizePageIntegrityOverrides(
    input.pageIntegrityOverrides
  );
  return {
    ...buildDocumentPageDirectoryScopeResources({
      scopePath: input.scopePath,
      records: state.records.map((record) => {
        const path = typeof record.path === "string" ? record.path : "";
        const integrity = integrityByPath.get(path);
        return integrity ? { ...record, ...integrity } : record;
      }),
      childDirectories: state.childDirectories,
      previousPaths: state.resourcePaths,
      maximumRecordsPerShard: input.maximumRecordsPerShard,
      maximumShardBytes: input.maximumShardBytes
    }),
    records: state.records,
    childDirectories: state.childDirectories
  };
}

function normalizePageIntegrityOverrides(
  values: readonly DocumentPageIntegrityOverride[]
): ReadonlyMap<string, Pick<
  DocumentPageIntegrityOverride,
  "checksumSha256" | "byteCount"
>> {
  const result = new Map<string, {
    checksumSha256: string;
    byteCount: number;
  }>();
  for (const value of values) {
    if (!value.path.startsWith("pages/") || !value.path.endsWith(".md")
      || !/^[0-9a-f]{64}$/u.test(value.checksumSha256)
      || !Number.isSafeInteger(value.byteCount) || value.byteCount < 0
      || result.has(value.path)) {
      throw scopeRenderError("page_integrity_override_invalid");
    }
    result.set(value.path, {
      checksumSha256: value.checksumSha256,
      byteCount: value.byteCount
    });
  }
  return result;
}
