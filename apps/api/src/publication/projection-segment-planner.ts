export type ProjectionSegmentChange = {
  projectionKind: string;
  logicalPartition: string;
  recordIdentity: string;
  action: "upsert" | "delete";
  encodedBytes: number;
};

export type PlannedProjectionSegment = {
  projectionKind: string;
  logicalPartition: string;
  segmentKind: "delta" | "tombstone";
  sequence: number;
  encodedBytes: number;
  changes: ProjectionSegmentChange[];
};

export function planProjectionSegments(input: {
  changes: ProjectionSegmentChange[];
  maxEntries: number;
  maxEncodedBytes: number;
}): { segments: PlannedProjectionSegment[]; descriptorCount: number } {
  assertPositiveInteger(input.maxEntries, "maxEntries");
  assertPositiveInteger(input.maxEncodedBytes, "maxEncodedBytes");
  const grouped = new Map<string, ProjectionSegmentChange[]>();
  const ordered = [...input.changes].sort(compareChanges);

  for (const change of ordered) {
    if (!Number.isInteger(change.encodedBytes) || change.encodedBytes < 0) {
      throw new Error("Projection segment encodedBytes must be a non-negative integer");
    }
    const segmentKind = change.action === "delete" ? "tombstone" : "delta";
    const key = `${change.projectionKind}\u0000${change.logicalPartition}\u0000${segmentKind}`;
    const group = grouped.get(key) ?? [];
    group.push(change);
    grouped.set(key, group);
  }

  const segments: PlannedProjectionSegment[] = [];
  for (const changes of grouped.values()) {
    let page: ProjectionSegmentChange[] = [];
    let pageBytes = 0;
    let sequence = 0;
    for (const change of changes) {
      if (
        page.length >= input.maxEntries
        || (page.length > 0 && pageBytes + change.encodedBytes > input.maxEncodedBytes)
      ) {
        segments.push(segment(page, pageBytes, sequence));
        page = [];
        pageBytes = 0;
        sequence += 1;
      }
      page.push(change);
      pageBytes += change.encodedBytes;
    }
    if (page.length > 0) segments.push(segment(page, pageBytes, sequence));
  }

  return {
    segments,
    descriptorCount: segments.length === 0 ? 0 : segments.length + 1
  };
}

function segment(
  changes: ProjectionSegmentChange[],
  encodedBytes: number,
  sequence: number
): PlannedProjectionSegment {
  const first = changes[0]!;
  return {
    projectionKind: first.projectionKind,
    logicalPartition: first.logicalPartition,
    segmentKind: first.action === "delete" ? "tombstone" : "delta",
    sequence,
    encodedBytes,
    changes
  };
}

function compareChanges(left: ProjectionSegmentChange, right: ProjectionSegmentChange): number {
  return left.projectionKind.localeCompare(right.projectionKind)
    || left.logicalPartition.localeCompare(right.logicalPartition)
    || left.action.localeCompare(right.action)
    || left.recordIdentity.localeCompare(right.recordIdentity);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}
