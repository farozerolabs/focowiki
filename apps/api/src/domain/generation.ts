import { createHash } from "node:crypto";

export const PUBLICATION_FORMAT_VERSION = 1;

export type WorkerRole = "source" | "publication" | "maintenance";

export type ChangeFactKind =
  | "source_created"
  | "source_replaced"
  | "source_metadata_changed"
  | "source_moved"
  | "source_renamed"
  | "directory_moved"
  | "knowledge_base_metadata_changed"
  | "source_deleted"
  | "directory_deleted"
  | "knowledge_base_deleted";

export type ProjectionKind =
  | "page"
  | "directory"
  | "root"
  | "search"
  | "links"
  | "manifest"
  | "tree"
  | "graph_node"
  | "graph_edge"
  | "graph_reverse_neighbor"
  | "related_files"
  | "cleanup";

export type ChangeFactIdentityInput = {
  knowledgeBaseId: string;
  sourceRevisionId: string | null;
  kind: ChangeFactKind;
  previousPath: string | null;
  path: string | null;
  mutationIdentity?: string | null;
};

export type ProjectionImpactIdentityInput = {
  changeFactId: string;
  projectionKind: ProjectionKind;
  projectionKey: string;
  recordIdentity: string;
  action: "upsert" | "delete" | "validate";
};

export function createChangeFactIdentity(input: ChangeFactIdentityInput): string {
  return `change-${stableDigest([
    input.knowledgeBaseId,
    input.sourceRevisionId ?? "-",
    input.kind,
    input.previousPath ?? "-",
    input.path ?? "-",
    input.mutationIdentity ?? "-"
  ])}`;
}

export function createProjectionImpactIdentity(
  input: ProjectionImpactIdentityInput
): string {
  return `impact-${stableDigest([
    input.changeFactId,
    input.projectionKind,
    input.projectionKey,
    input.recordIdentity,
    input.action
  ])}`;
}

export function resolveProjectionShard(input: {
  projectionKind: Exclude<ProjectionKind, "page" | "directory" | "root" | "cleanup">;
  stableIdentity: string;
  shardCount: number;
  formatVersion?: number;
}): string {
  assertPositiveInteger(input.shardCount, "shardCount");
  const formatVersion = input.formatVersion ?? PUBLICATION_FORMAT_VERSION;
  assertPositiveInteger(formatVersion, "formatVersion");
  const digest = createHash("sha256")
    .update(`${input.projectionKind}\u0000${input.stableIdentity}`, "utf8")
    .digest();
  const bucket = digest.readUInt32BE(0) % input.shardCount;
  const width = Math.max(4, String(input.shardCount - 1).length);

  return `${input.projectionKind}/v${formatVersion}/${String(bucket).padStart(width, "0")}`;
}

export function createImmutableObjectKey(input: {
  prefix: string;
  checksumSha256: string;
  formatVersion?: number;
}): string {
  const checksum = input.checksumSha256.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(checksum)) {
    throw new Error("checksumSha256 must be a SHA-256 hex digest");
  }
  const prefix = input.prefix.replace(/^\/+|\/+$/g, "");
  if (!prefix) {
    throw new Error("prefix must not be empty");
  }
  const formatVersion = input.formatVersion ?? PUBLICATION_FORMAT_VERSION;
  assertPositiveInteger(formatVersion, "formatVersion");

  return `${prefix}/generated/v${formatVersion}/objects/${checksum.slice(0, 2)}/${checksum}`;
}

function stableDigest(parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(String(Buffer.byteLength(part, "utf8")), "utf8");
    hash.update(":", "utf8");
    hash.update(part, "utf8");
    hash.update("\u0000", "utf8");
  }
  return hash.digest("hex").slice(0, 32);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}
