import type { RuntimeConfig, RuntimeLogLevel } from "./config.js";
import {
  createRuntimeFileLogSink,
  type RuntimeFileLogSink,
  type RuntimeStructuredLogRecord
} from "./file-log-sink.js";
import { sanitizeDiagnosticText } from "./runtime/error-diagnostics.js";

export type RuntimeDiagnosticValue = boolean | number | string | null;
export type RuntimeDiagnosticFields = Readonly<Record<string, RuntimeDiagnosticValue>>;
type FrozenDeveloperOpenApiDiagnosticFields = Readonly<{
  requestId: string;
  operationId: string;
  routeTemplate: string;
  resourceContext: Readonly<Record<string, string>>;
  errorClass: string;
  errorMessage: string;
  stack: string | null;
  durationMs: number;
  status: number;
}>;
type RuntimeDiagnosticInputFields =
  | RuntimeDiagnosticFields
  | FrozenDeveloperOpenApiDiagnosticFields;

export type RuntimeLogger = {
  error(eventName: string, fields?: RuntimeDiagnosticInputFields): void;
  warn(eventName: string, fields?: RuntimeDiagnosticInputFields): void;
  info(eventName: string, fields?: RuntimeDiagnosticInputFields): void;
  debug(eventName: string, fields?: RuntimeDiagnosticInputFields): void;
};

export type RuntimeLogSink = {
  error(record: RuntimeStructuredLogRecord): void;
  warn(record: RuntimeStructuredLogRecord): void;
  info(record: RuntimeStructuredLogRecord): void;
  debug(record: RuntimeStructuredLogRecord): void;
};

export type RuntimeLoggerOptions = {
  streamName?: string;
};

const DEFAULT_LOG_LEVEL: RuntimeLogLevel = "info";
const MAX_DIAGNOSTIC_FIELDS = 64;
const LOG_LEVEL_WEIGHT: Record<RuntimeLogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};
const SAFE_EVENT_NAME = /^[a-z][a-z0-9_.]{0,127}$/u;
const SAFE_FIELD_NAME = /^[a-z][a-zA-Z0-9]{0,63}$/u;
const FORBIDDEN_DIAGNOSTIC_FIELD =
  /(?:secret|token|password|credential|authorization|api.?key|body|content|markdown|prompt|response|sql|object.?(?:id|key|checksum)|checksum|bucket|storage.?(?:key|prefix)|index.?(?:uid|name)|task.?(?:uid|name)|table.?(?:id|name|identifier)|owner.?row|lease|generation.?(?:details|history|kind|payload|row|state)|cleanup|cookie|local.?path|source.?path|file.?path)/iu;
const FROZEN_EVENT_ALIASES: Readonly<Record<string, string>> = {
  "Developer OpenAPI request failed": "developer_openapi.request_failed"
};

export function createRuntimeLogger(
  config: Pick<RuntimeConfig, "logging">,
  sink: RuntimeLogSink = console,
  options: RuntimeLoggerOptions = {}
): RuntimeLogger {
  const configuredLevel = config.logging?.level ?? DEFAULT_LOG_LEVEL;
  const stream = safeStreamName(options.streamName ?? "runtime");
  const fileSink = config.logging?.file
    ? createRuntimeFileLogSink(config.logging.file, stream)
    : null;

  return {
    error(eventName, fields) {
      write("error", configuredLevel, sink, fileSink, stream, eventName, fields);
    },
    warn(eventName, fields) {
      write("warn", configuredLevel, sink, fileSink, stream, eventName, fields);
    },
    info(eventName, fields) {
      write("info", configuredLevel, sink, fileSink, stream, eventName, fields);
    },
    debug(eventName, fields) {
      write("debug", configuredLevel, sink, fileSink, stream, eventName, fields);
    }
  };
}

function write(
  level: RuntimeLogLevel,
  configuredLevel: RuntimeLogLevel,
  sink: RuntimeLogSink,
  fileSink: RuntimeFileLogSink | null,
  stream: string,
  eventName: string,
  fields: RuntimeDiagnosticInputFields | undefined
): void {
  if (LOG_LEVEL_WEIGHT[level] > LOG_LEVEL_WEIGHT[configuredLevel]) return;

  const record: RuntimeStructuredLogRecord = {
    timestamp: new Date().toISOString(),
    level,
    event: normalizeEventName(eventName),
    stream,
    fields: sanitizeFields(fields)
  };
  sink[level](record);
  if (!fileSink) return;

  try {
    fileSink.write(record);
  } catch (error) {
    sink.warn({
      timestamp: new Date().toISOString(),
      level: "warn",
      event: "runtime.file_logging_failed",
      stream,
      fields: {
        errorMessage: sanitizeDiagnosticText(
          error instanceof Error ? error.message : String(error)
        )
      }
    });
  }
}

function sanitizeFields(
  fields: RuntimeDiagnosticInputFields | undefined
): RuntimeDiagnosticFields {
  if (!fields) return {};
  const output: Record<string, RuntimeDiagnosticValue> = {};
  for (const [key, value] of Object.entries(fields).slice(0, MAX_DIAGNOSTIC_FIELDS)) {
    if (key === "resourceContext" && isStringRecord(value)) {
      for (const [resourceKey, resourceValue] of Object.entries(value).slice(0, 8)) {
        if (
          SAFE_FIELD_NAME.test(resourceKey)
          && !FORBIDDEN_DIAGNOSTIC_FIELD.test(resourceKey)
        ) {
          output[resourceKey] = sanitizeDiagnosticText(resourceValue);
        }
      }
      continue;
    }
    if (!SAFE_FIELD_NAME.test(key) || FORBIDDEN_DIAGNOSTIC_FIELD.test(key)) continue;
    if (typeof value === "string") {
      output[key] = sanitizeDiagnosticText(value);
    } else if (typeof value === "number") {
      output[key] = Number.isFinite(value) ? value : null;
    } else if (typeof value === "boolean" || value === null) {
      output[key] = value;
    }
  }
  return output;
}

function normalizeEventName(eventName: string): string {
  const aliased = FROZEN_EVENT_ALIASES[eventName] ?? eventName;
  return SAFE_EVENT_NAME.test(aliased)
    ? aliased
    : "runtime.invalid_diagnostic_event";
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.values(value).every((entry) => typeof entry === "string");
}

function safeStreamName(value: string): string {
  return value.replace(/[^a-z0-9_-]/giu, "-").toLowerCase().slice(0, 64) || "runtime";
}
