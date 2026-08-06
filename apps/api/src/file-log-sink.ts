import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import type { RuntimeLogLevel } from "./config.js";

export type RuntimeFileLogConfig = {
  directory: string;
  maxBytes: number;
  maxFiles: number;
  maxTotalBytes: number;
  retentionDays: number;
};

export type RuntimeStructuredLogRecord = {
  timestamp: string;
  level: RuntimeLogLevel;
  event: string;
  stream: string;
  fields: Readonly<Record<string, boolean | number | string | null>>;
};

export type RuntimeFileLogSink = {
  write(record: RuntimeStructuredLogRecord): void;
};

export function createRuntimeFileLogSink(
  config: RuntimeFileLogConfig,
  streamName: string
): RuntimeFileLogSink {
  const safeStreamName = streamName.replace(/[^a-z0-9_-]/gi, "-").toLowerCase() || "runtime";
  const activePath = join(config.directory, `focowiki-${safeStreamName}.log`);

  return {
    write(record) {
      mkdirSync(config.directory, { recursive: true });
      deleteExpiredFiles(activePath, config.retentionDays, Date.now());
      const line = serializeBoundedLine(record, config.maxBytes);
      rotateIfNeeded(activePath, Buffer.byteLength(line), config.maxBytes, config.maxFiles);
      appendFileSync(activePath, line, "utf8");
      pruneTotalBytes(activePath, config.maxTotalBytes);
    }
  };
}

function serializeBoundedLine(
  record: RuntimeStructuredLogRecord,
  maxBytes: number
): string {
  const line = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(line) <= maxBytes) return line;

  const fallback = `${JSON.stringify({
    timestamp: record.timestamp,
    level: record.level,
    event: "runtime.log_record_too_large",
    stream: record.stream,
    fields: { code: "LOG_RECORD_TOO_LARGE" }
  } satisfies RuntimeStructuredLogRecord)}\n`;
  if (Buffer.byteLength(fallback) > maxBytes) {
    throw new Error("Runtime file log limit cannot fit a structured record");
  }
  return fallback;
}

function rotateIfNeeded(
  activePath: string,
  nextBytes: number,
  maxBytes: number,
  maxFiles: number
): void {
  if (!existsSync(activePath)) return;
  if (statSync(activePath).size + nextBytes <= maxBytes) return;
  rotateFiles(activePath, maxFiles);
}

function rotateFiles(activePath: string, maxFiles: number): void {
  if (maxFiles <= 1) {
    rmSync(activePath, { force: true });
    return;
  }

  const lastIndex = maxFiles - 1;
  rmSync(rotatedPath(activePath, lastIndex), { force: true });
  for (let index = lastIndex - 1; index >= 1; index -= 1) {
    const source = rotatedPath(activePath, index);
    if (existsSync(source)) renameSync(source, rotatedPath(activePath, index + 1));
  }

  if (!existsSync(activePath)) return;
  const activeStat = statSync(activePath);
  const compressedPath = rotatedPath(activePath, 1);
  writeFileSync(compressedPath, gzipSync(readFileSync(activePath)));
  utimesSync(compressedPath, activeStat.atime, activeStat.mtime);
  rmSync(activePath, { force: true });
}

function deleteExpiredFiles(
  activePath: string,
  retentionDays: number,
  nowMs: number
): void {
  const cutoff = nowMs - retentionDays * 86_400_000;
  for (const file of listOwnedLogFiles(activePath)) {
    if (file === activePath) continue;
    if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true });
  }
}

function pruneTotalBytes(activePath: string, maxTotalBytes: number): void {
  const files = listOwnedLogFiles(activePath).map((path) => ({
    path,
    bytes: statSync(path).size,
    modifiedAt: statSync(path).mtimeMs
  }));
  let totalBytes = files.reduce((total, file) => total + file.bytes, 0);
  const removable = files
    .filter((file) => file.path !== activePath)
    .sort((left, right) =>
      left.modifiedAt - right.modifiedAt || left.path.localeCompare(right.path, "en")
    );
  for (const file of removable) {
    if (totalBytes <= maxTotalBytes) break;
    rmSync(file.path, { force: true });
    totalBytes -= file.bytes;
  }
  if (totalBytes > maxTotalBytes) {
    throw new Error("Runtime file logs exceeded the configured total-byte limit");
  }
}

function listOwnedLogFiles(activePath: string): string[] {
  const directory = dirname(activePath);
  const activeName = basename(activePath);
  const rotatedPrefix = activeName.replace(/\.log$/u, ".");
  return readdirSync(directory)
    .filter((name) =>
      name === activeName
      || (name.startsWith(rotatedPrefix) && name.endsWith(".log.gz"))
    )
    .map((name) => join(directory, name));
}

function rotatedPath(activePath: string, index: number): string {
  return activePath.replace(/\.log$/u, `.${index}.log.gz`);
}
