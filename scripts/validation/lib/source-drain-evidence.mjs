export function calculateSourceDrainMetrics(rows, expectedCount) {
  if (!Number.isSafeInteger(expectedCount) || expectedCount <= 0) {
    throw new Error("Expected source count must be a positive integer.");
  }
  const completed = rows
    .filter((row) => row.status === "completed" && row.startedAt && row.endedAt)
    .map((row) => ({
      ...row,
      startedAtMs: parseTimestamp(row.startedAt, "startedAt"),
      endedAtMs: parseTimestamp(row.endedAt, "endedAt")
    }))
    .sort((left, right) => left.endedAtMs - right.endedAtMs);
  if (completed.length !== expectedCount) {
    throw new Error(
      `Expected ${expectedCount} completed source rows, received ${completed.length}.`
    );
  }

  const quintileSize = Math.ceil(completed.length / 5);
  const quintiles = [];
  for (let offset = 0; offset < completed.length; offset += quintileSize) {
    const group = completed.slice(offset, Math.min(offset + quintileSize, completed.length));
    quintiles.push({
      number: quintiles.length + 1,
      fileCount: group.length,
      completionSpanMs: completionSpanMs(group),
      filesPerSecond: completionThroughput(group)
    });
  }
  const warmupExcludedCount = quintiles[0]?.fileCount ?? 0;
  const warmed = completed.slice(warmupExcludedCount);
  const coldRate = quintiles[0]?.filesPerSecond ?? 0;
  const firstWarmedRate = quintiles[1]?.filesPerSecond ?? 0;
  const lastRate = quintiles.at(-1)?.filesPerSecond ?? 0;
  const coldToTailQuintileDriftPercent = rateDriftPercent(coldRate, lastRate);
  const warmedQuintileDriftPercent = quintiles.length > 2
    ? rateDriftPercent(firstWarmedRate, lastRate)
    : 0;

  return {
    completedCount: completed.length,
    wallClockMs: Math.max(...completed.map((row) => row.endedAtMs))
      - Math.min(...completed.map((row) => row.startedAtMs)),
    completionSpanMs: completionSpanMs(completed),
    filesPerSecond: completionThroughput(completed),
    warmupExcludedCount,
    warmedCompletionSpanMs: completionSpanMs(warmed),
    warmedFilesPerSecond: completionThroughput(warmed),
    coldToTailQuintileDriftPercent,
    warmedQuintileDriftPercent,
    quintiles
  };
}

function rateDriftPercent(firstRate, lastRate) {
  return firstRate > 0
    ? round(Math.abs(lastRate - firstRate) / firstRate * 100)
    : 0;
}

function completionThroughput(rows) {
  if (rows.length === 0) return 0;
  if (rows.length === 1) {
    const serviceMs = Math.max(rows[0].endedAtMs - rows[0].startedAtMs, 1);
    return round(1_000 / serviceMs);
  }
  return round((rows.length - 1) / Math.max(completionSpanMs(rows) / 1_000, 0.001));
}

function completionSpanMs(rows) {
  if (rows.length <= 1) return 0;
  return Math.max(...rows.map((row) => row.endedAtMs))
    - Math.min(...rows.map((row) => row.endedAtMs));
}

function parseTimestamp(value, field) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Source drain ${field} is invalid.`);
  return parsed;
}

function round(value) {
  return Math.round(value * 100) / 100;
}
