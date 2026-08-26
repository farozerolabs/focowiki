import { createHash } from "node:crypto";
import type { DocumentPublicationRenderScope } from
  "../application/document-publication-job-ports.js";
import {
  DOCUMENT_TERM_BUCKETS,
  type DocumentTermBucket
} from "../application/document-term-routing.js";

export function sourceFileScope(
  scope: DocumentPublicationRenderScope
): string | null {
  if (scope.kind !== "source") return null;
  if (!scope.key.trim()) {
    throw scopeRenderError("projection_scope_source_invalid");
  }
  return scope.key;
}

export function latestContributors<T extends {
  sourceFilePublicId: string;
  requiredSequence: number;
}>(contributors: readonly T[]): T[] {
  const latest = new Map<string, T>();
  for (const contributor of contributors) {
    const current = latest.get(contributor.sourceFilePublicId);
    if (!current || contributor.requiredSequence >= current.requiredSequence) {
      latest.set(contributor.sourceFilePublicId, contributor);
    }
  }
  return [...latest.values()].sort((left, right) =>
    left.sourceFilePublicId.localeCompare(right.sourceFilePublicId, "en-US"));
}

export function termBucket(
  scope: DocumentPublicationRenderScope
): DocumentTermBucket | null {
  if (scope.kind !== "_index" || !scope.key.startsWith("term:")) return null;
  const bucket = scope.key.slice("term:".length) as DocumentTermBucket;
  if (!DOCUMENT_TERM_BUCKETS.includes(bucket)) {
    throw scopeRenderError("projection_scope_term_bucket_invalid");
  }
  return bucket;
}

export function pageDirectoryScope(
  scope: DocumentPublicationRenderScope
): string | null {
  if (scope.kind !== "_index" || !scope.key.startsWith("pages:")) return null;
  return requirePageScope(
    scope.key.slice("pages:".length),
    "projection_scope_page_directory_invalid"
  );
}

export function semanticDirectoryScope(
  scope: DocumentPublicationRenderScope
): string | null {
  if (scope.kind !== "directory") return null;
  return requirePageScope(
    scope.key,
    "projection_scope_semantic_directory_invalid"
  );
}

export function graphDirectoryScope(
  scope: DocumentPublicationRenderScope
): string | null {
  if (scope.kind !== "_graph" || !scope.key.startsWith("directory:")) {
    return null;
  }
  return requirePageScope(
    scope.key.slice("directory:".length),
    "projection_scope_graph_directory_invalid"
  );
}

export function perFileGraphDirectoryScope(
  scope: DocumentPublicationRenderScope
): string | null {
  if (scope.kind !== "_graph" || !scope.key.startsWith("file-directory:")) {
    return null;
  }
  return requirePageScope(
    scope.key.slice("file-directory:".length),
    "projection_scope_file_graph_directory_invalid"
  );
}

export function perFileGraphSourceId(
  scope: DocumentPublicationRenderScope
): string | null {
  if (scope.kind !== "_graph"
    || scope.key === "catalog"
    || scope.key.startsWith("directory:")
    || scope.key.startsWith("file-directory:")) return null;
  if (!scope.key.trim()) {
    throw scopeRenderError("projection_scope_file_graph_invalid");
  }
  return scope.key;
}

export function writeAttemptId(
  scope: DocumentPublicationRenderScope,
  normalizedPath: string,
  checksumSha256: string
): string {
  return `projection-scope-write-${createHash("sha256")
    .update(JSON.stringify([
      scope.publicId,
      scope.renderedSequence,
      normalizedPath,
      checksumSha256
    ]))
    .digest("hex")}`;
}

export function validateScopeRendererConfiguration(input: {
  maximumRecordsPerShard: number;
  maximumShardBytes: number;
}): void {
  if (!Number.isSafeInteger(input.maximumRecordsPerShard)
    || input.maximumRecordsPerShard < 1
    || input.maximumRecordsPerShard > 10_000
    || !Number.isSafeInteger(input.maximumShardBytes)
    || input.maximumShardBytes < 1_024
    || input.maximumShardBytes > 16_777_216) {
    throw scopeRenderError("projection_scope_renderer_configuration_invalid");
  }
}

export function zeroStorageRequests() {
  return {
    put: 0,
    head: 0,
    verification: 0,
    attemptedBytes: 0,
    retries: 0,
    latencyMilliseconds: 0
  };
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right, "en-US"))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

export function scopeRenderError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Projection scope render error: ${code}`), {
    code
  });
}

function requirePageScope(scopePath: string, errorCode: string): string {
  if (scopePath !== "pages" && !scopePath.startsWith("pages/")) {
    throw scopeRenderError(errorCode);
  }
  return scopePath;
}
