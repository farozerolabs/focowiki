import { createHash } from "node:crypto";

const SEGMENT_KINDS = new Set(["base", "compacted", "delta", "tombstone"]);

export async function readProjectionRecords(input) {
  const body = await input.readText(input.logicalPath);
  const parsed = parseJson(body, input.logicalPath);
  if (parsed.projection !== input.projectionKind) {
    throw new Error(`Projection kind differs from its catalog descriptor: ${input.logicalPath}`);
  }

  if (Array.isArray(parsed.records) && !Array.isArray(parsed.segments)) {
    const records = validateRecords(parsed.records, input.logicalPath);
    assertRecordCount(records.length, input.expectedRecordCount, input.logicalPath);
    return records;
  }

  validateManifest(parsed, input.logicalPath, input.expectedRecordCount);
  let previousSequence = -1;
  for (const descriptor of parsed.segments) {
    validateSegmentDescriptor(descriptor, input.logicalPath, previousSequence);
    previousSequence = descriptor.sequence;
  }
  const inlineSegments = validateInlineSegments(
    parsed.inlineSegments ?? [],
    parsed,
    input.logicalPath,
    previousSequence
  );

  const segmentPayloads = await mapWithConcurrency(
    parsed.segments,
    normalizeConcurrency(input.segmentReadConcurrency),
    async (descriptor) => {
      const segmentBody = await input.readText(descriptor.path);
      if (typeof segmentBody !== "string") {
        throw new Error(`Projection segment is unavailable: ${descriptor.path}`);
      }
      const checksum = createHash("sha256").update(segmentBody).digest("hex");
      if (checksum !== descriptor.checksumSha256) {
        throw new Error(`Projection segment checksum differs from its manifest: ${descriptor.path}`);
      }
      if (Buffer.byteLength(segmentBody, "utf8") !== descriptor.encodedBytes) {
        throw new Error(`Projection segment byte size differs from its manifest: ${descriptor.path}`);
      }
      const segment = parseJson(segmentBody, descriptor.path);
      const payload = readSegmentPayload(segment, descriptor, parsed, descriptor.path);
      const records = validateRecords(payload.records ?? [], descriptor.path);
      const tombstones = validateTombstones(payload.tombstones ?? [], descriptor.path);
      if (records.length + tombstones.length !== descriptor.entryCount) {
        throw new Error(`Projection segment entry count differs from its manifest: ${descriptor.path}`);
      }
      return { descriptor, records, tombstones };
    }
  );

  const effective = new Map();
  for (const { descriptor, records, tombstones } of [...segmentPayloads, ...inlineSegments]) {
    if (descriptor.kind === "base" || descriptor.kind === "compacted") {
      effective.clear();
    }
    for (const recordId of tombstones) effective.delete(recordId);
    for (const record of records) effective.set(record.id, record);
  }

  const records = [...effective.values()].sort((left, right) => left.id.localeCompare(right.id, "en"));
  assertRecordCount(records.length, parsed.recordCount, input.logicalPath);
  assertRecordCount(records.length, input.expectedRecordCount, input.logicalPath);
  return records;
}

function readSegmentPayload(value, descriptor, manifest, logicalPath) {
  if (value.formatVersion === 3) {
    if (
      value.projection !== manifest.projection
      || value.logicalPartition !== manifest.logicalPartition
      || !Array.isArray(value.inlineSegments)
      || value.inlineSegments.length !== 1
    ) {
      throw new Error(`Projection segment payload is malformed: ${logicalPath}`);
    }
    const [payload] = validateInlineSegments(
      value.inlineSegments,
      value,
      logicalPath,
      descriptor.sequence - 1
    );
    if (
      !payload
      || payload.descriptor.kind !== descriptor.kind
      || payload.descriptor.sequence !== descriptor.sequence
    ) {
      throw new Error(`Projection segment payload is malformed: ${logicalPath}`);
    }
    return payload;
  }

  validateSegment(value, descriptor, manifest, logicalPath);
  return value;
}

export async function readProjectionCatalogRecords(input) {
  if (!Array.isArray(input.shards)) {
    throw new Error("Projection catalog shard descriptors are unavailable.");
  }
  for (const shard of input.shards) {
    if (
      !shard
      || typeof shard.path !== "string"
      || !Number.isSafeInteger(shard.recordCount)
      || shard.recordCount < 0
    ) {
      throw new Error("Projection catalog includes an invalid shard descriptor.");
    }
  }

  const shardRecords = await mapWithConcurrency(
    input.shards,
    normalizeConcurrency(input.shardReadConcurrency),
    (shard) => readProjectionRecords({
      logicalPath: shard.path,
      projectionKind: input.projectionKind,
      expectedRecordCount: shard.recordCount,
      segmentReadConcurrency: input.segmentReadConcurrency,
      readText: input.readText
    })
  );
  return shardRecords.flat();
}

function validateManifest(value, logicalPath, expectedRecordCount) {
  if (
    ![2, 3].includes(value.formatVersion)
    || typeof value.logicalPartition !== "string"
    || !Number.isSafeInteger(value.recordCount)
    || value.recordCount < 0
    || value.recordCount !== expectedRecordCount
    || !Array.isArray(value.segments)
    || (value.formatVersion === 2 && value.inlineSegments !== undefined)
    || (value.formatVersion === 3 && !Array.isArray(value.inlineSegments))
  ) {
    throw new Error(`Projection manifest is malformed: ${logicalPath}`);
  }
}

function validateInlineSegments(values, manifest, logicalPath, previousSequence) {
  const result = [];
  let sequence = previousSequence;
  for (const value of values) {
    if (
      !value
      || typeof value !== "object"
      || !SEGMENT_KINDS.has(value.kind)
      || !Number.isSafeInteger(value.sequence)
      || value.sequence < 0
      || value.sequence <= sequence
      || !Number.isSafeInteger(value.entryCount)
      || value.entryCount < 0
      || (value.records !== undefined && !Array.isArray(value.records))
      || (value.tombstones !== undefined && !Array.isArray(value.tombstones))
    ) {
      throw new Error(`Projection manifest includes an invalid inline segment: ${logicalPath}`);
    }
    const records = validateRecords(value.records ?? [], logicalPath);
    const tombstones = validateTombstones(value.tombstones ?? [], logicalPath);
    if (records.length + tombstones.length !== value.entryCount) {
      throw new Error(`Projection inline segment entry count differs from its manifest: ${logicalPath}`);
    }
    result.push({
      descriptor: { kind: value.kind, sequence: value.sequence },
      records,
      tombstones
    });
    sequence = value.sequence;
  }
  return result;
}

function validateSegmentDescriptor(value, manifestPath, previousSequence) {
  if (
    !value
    || typeof value !== "object"
    || !SEGMENT_KINDS.has(value.kind)
    || !Number.isSafeInteger(value.sequence)
    || value.sequence < 0
    || value.sequence <= previousSequence
    || typeof value.path !== "string"
    || !isSafeSegmentPath(value.path)
    || typeof value.checksumSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(value.checksumSha256)
    || !Number.isSafeInteger(value.entryCount)
    || value.entryCount < 0
    || !Number.isSafeInteger(value.encodedBytes)
    || value.encodedBytes <= 0
  ) {
    throw new Error(`Projection manifest includes an invalid segment descriptor: ${manifestPath}`);
  }
}

function validateSegment(value, descriptor, manifest, logicalPath) {
  if (
    value.formatVersion !== 2
    || value.projection !== manifest.projection
    || value.logicalPartition !== manifest.logicalPartition
    || value.segmentKind !== descriptor.kind
    || value.sequenceNumber !== descriptor.sequence
    || (value.records !== undefined && !Array.isArray(value.records))
    || (value.tombstones !== undefined && !Array.isArray(value.tombstones))
  ) {
    throw new Error(`Projection segment payload is malformed: ${logicalPath}`);
  }
}

function validateRecords(value, logicalPath) {
  if (value.some((record) => !record || typeof record !== "object" || typeof record.id !== "string")) {
    throw new Error(`Projection records are malformed: ${logicalPath}`);
  }
  return value;
}

function validateTombstones(value, logicalPath) {
  if (value.some((recordId) => typeof recordId !== "string" || recordId.length === 0)) {
    throw new Error(`Projection tombstones are malformed: ${logicalPath}`);
  }
  return value;
}

function parseJson(raw, logicalPath) {
  if (typeof raw !== "string") {
    throw new Error(`Projection object is unavailable: ${logicalPath}`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error(`Projection object is not valid JSON: ${logicalPath}`);
  }
}

function assertRecordCount(actual, expected, logicalPath) {
  if (actual !== expected) {
    throw new Error(`Projection record count differs from its catalog descriptor: ${logicalPath}`);
  }
}

function isSafeSegmentPath(value) {
  return value.startsWith("_segments/")
    && !value.startsWith("/")
    && !value.includes("..")
    && !value.includes("\\")
    && value.endsWith(".json");
}

function normalizeConcurrency(value) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 16) : 4;
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker())
  );
  return results;
}
