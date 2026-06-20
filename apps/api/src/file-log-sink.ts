import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeLogLevel } from "./config.js";

export type RuntimeFileLogConfig = {
  directory: string;
  maxBytes: number;
  maxFiles: number;
};

export type RuntimeFileLogSink = {
  write(level: RuntimeLogLevel, parts: string[]): void;
};

export function createRuntimeFileLogSink(
  config: RuntimeFileLogConfig,
  streamName: string
): RuntimeFileLogSink {
  const safeStreamName = streamName.replace(/[^a-z0-9_-]/gi, "-").toLowerCase() || "runtime";
  const activePath = join(config.directory, `focowiki-${safeStreamName}.log`);

  return {
    write(level, parts) {
      const line = `${new Date().toISOString()} ${level.toUpperCase()} ${parts.join(" ")}\n`;
      mkdirSync(config.directory, { recursive: true });
      rotateIfNeeded(activePath, Buffer.byteLength(line), config.maxBytes, config.maxFiles);
      appendFileSync(activePath, line, "utf8");
    }
  };
}

function rotateIfNeeded(
  activePath: string,
  nextBytes: number,
  maxBytes: number,
  maxFiles: number
): void {
  if (!existsSync(activePath)) {
    return;
  }

  const currentBytes = statSync(activePath).size;

  if (currentBytes + nextBytes <= maxBytes) {
    return;
  }

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

    if (existsSync(source)) {
      renameSync(source, rotatedPath(activePath, index + 1));
    }
  }

  if (existsSync(activePath)) {
    renameSync(activePath, rotatedPath(activePath, 1));
  }
}

function rotatedPath(activePath: string, index: number): string {
  return activePath.replace(/\.log$/, `.${index}.log`);
}
