import type { RuntimeConfig, RuntimeLogLevel } from "./config.js";
import { redactSecrets } from "./errors.js";
import { createRuntimeFileLogSink, type RuntimeFileLogSink } from "./file-log-sink.js";

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

export type RuntimeLoggerOptions = {
  streamName?: string;
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
  sink: RuntimeLogSink = console,
  options: RuntimeLoggerOptions = {}
): RuntimeLogger {
  const configuredLevel = config.logging?.level ?? DEFAULT_LOG_LEVEL;
  const fileSink = config.logging?.file
    ? createRuntimeFileLogSink(config.logging.file, options.streamName ?? "runtime")
    : null;

  return {
    error(...parts) {
      write("error", configuredLevel, sink, fileSink, parts);
    },
    warn(...parts) {
      write("warn", configuredLevel, sink, fileSink, parts);
    },
    info(...parts) {
      write("info", configuredLevel, sink, fileSink, parts);
    },
    debug(...parts) {
      write("debug", configuredLevel, sink, fileSink, parts);
    }
  };
}

function write(
  level: RuntimeLogLevel,
  configuredLevel: RuntimeLogLevel,
  sink: RuntimeLogSink,
  fileSink: RuntimeFileLogSink | null,
  parts: unknown[]
): void {
  if (LOG_LEVEL_WEIGHT[level] > LOG_LEVEL_WEIGHT[configuredLevel]) {
    return;
  }

  const formattedParts = parts.map(formatLogPart);
  sink[level](...formattedParts);

  if (!fileSink) {
    return;
  }

  try {
    fileSink.write(level, formattedParts);
  } catch (error) {
    sink.warn("Runtime file logging failed", formatLogPart(error));
  }
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
