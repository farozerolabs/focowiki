import type { RuntimeConfig, RuntimeLogLevel } from "./config.js";
import { redactSecrets } from "./errors.js";

export type RuntimeLogger = {
  error(...parts: unknown[]): void;
  warn(...parts: unknown[]): void;
  info(...parts: unknown[]): void;
  debug(...parts: unknown[]): void;
};

export type RuntimeLogSink = {
  error(...parts: unknown[]): void;
  warn(...parts: unknown[]): void;
  info(...parts: unknown[]): void;
  debug(...parts: unknown[]): void;
};

const DEFAULT_LOG_LEVEL: RuntimeLogLevel = "info";
const LOG_LEVEL_WEIGHT: Record<RuntimeLogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

export function createRuntimeLogger(
  config: Pick<RuntimeConfig, "logging">,
  sink: RuntimeLogSink = console
): RuntimeLogger {
  const configuredLevel = config.logging?.level ?? DEFAULT_LOG_LEVEL;

  return {
    error(...parts) {
      write("error", configuredLevel, sink, parts);
    },
    warn(...parts) {
      write("warn", configuredLevel, sink, parts);
    },
    info(...parts) {
      write("info", configuredLevel, sink, parts);
    },
    debug(...parts) {
      write("debug", configuredLevel, sink, parts);
    }
  };
}

function write(
  level: RuntimeLogLevel,
  configuredLevel: RuntimeLogLevel,
  sink: RuntimeLogSink,
  parts: unknown[]
): void {
  if (LOG_LEVEL_WEIGHT[level] > LOG_LEVEL_WEIGHT[configuredLevel]) {
    return;
  }

  sink[level](...parts.map(formatLogPart));
}

function formatLogPart(part: unknown): string {
  if (part instanceof Error) {
    return redactSecrets(part.message);
  }

  if (typeof part === "string") {
    return redactSecrets(part);
  }

  return redactSecrets(part);
}
