import { createHash } from "node:crypto";

export type DirtyCommunityReason =
  | "entity_changed" | "relationship_changed" | "membership_changed"
  | "deleted" | "merge" | "split";

export type DirtyCommunityPartition = {
  publicId: string;
  partitionKey: string;
  reasonKind: DirtyCommunityReason;
  inputVersion: string;
};

export type CommunityRelationshipInput = {
  publicId: string;
  fromEntityPublicId: string;
  toEntityPublicId: string;
  weight: number;
};

export function deriveEntityPartitionAssignments(input: {
  entityPublicIds: readonly string[];
  inputVersion: string;
}): Array<{ entityPublicId: string; partitionKey: string; inputVersion: string }> {
  assertIdentity(input.inputVersion);
  return unique(input.entityPublicIds).map((entityPublicId) => ({
    entityPublicId,
    partitionKey: entityPartitionKey(entityPublicId),
    inputVersion: input.inputVersion
  }));
}

export function deriveDirtyCommunityPartitions(input: {
  knowledgeBaseId: string;
  semanticGenerationPublicId: string;
  inputVersion: string;
  reasonKind: DirtyCommunityReason;
  changedEntityPublicIds: readonly string[];
  changedRelationships: readonly Omit<CommunityRelationshipInput, "weight">[];
  priorMembershipPartitionKeys: readonly string[];
  boundaryNeighborEntityPublicIds: readonly string[];
  maximumBoundaryNeighbors: number;
}): DirtyCommunityPartition[] {
  assertIdentity(input.knowledgeBaseId);
  assertIdentity(input.semanticGenerationPublicId);
  assertIdentity(input.inputVersion);
  assertBound(input.maximumBoundaryNeighbors, 0, 10_000);
  const boundary = unique(input.boundaryNeighborEntityPublicIds)
    .slice(0, input.maximumBoundaryNeighbors);
  const entityIds = unique([
    ...input.changedEntityPublicIds,
    ...input.changedRelationships.flatMap((relationship) => [
      relationship.fromEntityPublicId,
      relationship.toEntityPublicId
    ]),
    ...boundary
  ]);
  const partitionKeys = unique([
    ...input.priorMembershipPartitionKeys,
    ...entityIds.map(entityPartitionKey)
  ]);
  return partitionKeys.map((partitionKey) => ({
    publicId: hash(
      "dirty-community", input.knowledgeBaseId,
      input.semanticGenerationPublicId, partitionKey
    ),
    partitionKey,
    reasonKind: input.reasonKind,
    inputVersion: input.inputVersion
  }));
}

export function assembleBoundedCommunityPartition(input: {
  partitionKey: string;
  inputVersion: string;
  cursor: string | null;
  entities: readonly string[];
  relationships: readonly CommunityRelationshipInput[];
  maximumEntities: number;
  maximumRelationships: number;
  maximumBoundaryRelationships: number;
}) {
  assertIdentity(input.partitionKey);
  assertIdentity(input.inputVersion);
  assertBound(input.maximumEntities, 1, 10_000);
  assertBound(input.maximumRelationships, 0, 20_000);
  assertBound(input.maximumBoundaryRelationships, 0, 10_000);
  if (input.entities.length > input.maximumEntities + 1) {
    throw new Error("Community entity page exceeds its bounded database input");
  }
  if (input.relationships.length
    > input.maximumRelationships + input.maximumBoundaryRelationships + 1) {
    throw new Error("Community relationship page exceeds its bounded database input");
  }
  const orderedEntities = unique(input.entities)
    .filter((publicId) => input.cursor === null || publicId > input.cursor);
  const entityPublicIds = orderedEntities.slice(0, input.maximumEntities);
  const selected = new Set(entityPublicIds);
  const orderedRelationships = [...input.relationships].sort(compareRelationship);
  const localRelationships = orderedRelationships.filter((relationship) =>
    selected.has(relationship.fromEntityPublicId)
    && selected.has(relationship.toEntityPublicId)
  ).slice(0, input.maximumRelationships);
  const boundaryRelationships = orderedRelationships.filter((relationship) =>
    selected.has(relationship.fromEntityPublicId)
      !== selected.has(relationship.toEntityPublicId)
  ).slice(0, input.maximumBoundaryRelationships);
  return {
    partitionKey: input.partitionKey,
    inputVersion: input.inputVersion,
    entityPublicIds,
    localRelationships,
    boundaryRelationships,
    boundaryVersion: hash(
      "community-boundary",
      ...boundaryRelationships.flatMap((relationship) => [
        relationship.publicId,
        relationship.fromEntityPublicId,
        relationship.toEntityPublicId
      ])
    ),
    nextCursor: orderedEntities.length > input.maximumEntities
      ? entityPublicIds.at(-1) ?? null
      : null
  };
}

export function buildBoundedParentSummaryInput(input: {
  childSummaries: readonly string[];
  maximumChildren: number;
  maximumCharacters: number;
}): string[] {
  assertBound(input.maximumChildren, 1, 10_000);
  assertBound(input.maximumCharacters, 1, 1_000_000);
  const result: string[] = [];
  let characters = 0;
  for (const summary of unique(input.childSummaries)) {
    if (result.length >= input.maximumChildren) break;
    if (!summary || summary.length > input.maximumCharacters) continue;
    const next = characters + summary.length;
    if (next > input.maximumCharacters) break;
    result.push(summary);
    characters = next;
  }
  return result;
}

export function acceptCommunityPartitionResult(input: {
  expectedInputVersion: string;
  resultInputVersion: string;
  priorChecksumSha256: string | null;
  resultChecksumSha256: string;
}): { outcome: "created" | "updated" | "reused"; changed: boolean } {
  if (input.resultInputVersion !== input.expectedInputVersion) {
    throw new Error("Community partition result is stale");
  }
  if (!/^[0-9a-f]{64}$/u.test(input.resultChecksumSha256)) {
    throw new Error("Community partition checksum is invalid");
  }
  if (input.priorChecksumSha256 === input.resultChecksumSha256) {
    return { outcome: "reused", changed: false };
  }
  return {
    outcome: input.priorChecksumSha256 === null ? "created" : "updated",
    changed: true
  };
}

function entityPartitionKey(publicId: string): string {
  assertIdentity(publicId);
  return `entity-${hash("community-partition", publicId).slice(0, 2)}`;
}

function compareRelationship(
  left: CommunityRelationshipInput,
  right: CommunityRelationshipInput
): number {
  return left.publicId.localeCompare(right.publicId, "en")
    || left.fromEntityPublicId.localeCompare(right.fromEntityPublicId, "en")
    || left.toEntityPublicId.localeCompare(right.toEntityPublicId, "en");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) =>
    left.localeCompare(right, "en")
  );
}

function assertIdentity(value: string): void {
  if (!value || value.length > 1024) throw new Error("Community identity is invalid");
}

function assertBound(value: number, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error("Community bound is invalid");
  }
}

function hash(...values: string[]): string {
  return createHash("sha256").update(values.join("\u001f")).digest("hex");
}
