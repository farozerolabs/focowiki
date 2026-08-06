import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  createRuntimeLogger,
  type RuntimeLogSink
} from "../src/logger.js";
import type { RuntimeStructuredLogRecord } from "../src/file-log-sink.js";

type SinkCall = {
  level: "error" | "warn" | "info" | "debug";
  record: RuntimeStructuredLogRecord;
};

function createSink() {
  const calls: SinkCall[] = [];
  const sink: RuntimeLogSink = {
    error(record) {
      calls.push({ level: "error", record });
    },
    warn(record) {
      calls.push({ level: "warn", record });
    },
    info(record) {
      calls.push({ level: "info", record });
    },
    debug(record) {
      calls.push({ level: "debug", record });
    }
  };
  return { calls, sink };
}

describe("createRuntimeLogger", () => {
  it("filters structured events below the configured level", () => {
    const { calls, sink } = createSink();
    const logger = createRuntimeLogger({ logging: { level: "warn" } }, sink);

    logger.debug("runtime.debug_details");
    logger.info("runtime.started");
    logger.warn("runtime.slow_request");
    logger.error("runtime.failed_request");

    expect(calls.map((call) => call.level)).toEqual(["warn", "error"]);
    expect(calls.map((call) => call.record.event)).toEqual([
      "runtime.slow_request",
      "runtime.failed_request"
    ]);
  });

  it("redacts safe values and drops sensitive or nested fields", () => {
    const { calls, sink } = createSink();
    const logger = createRuntimeLogger({ logging: { level: "debug" } }, sink);

    logger.error("model.request_failed", {
      errorMessage: "MODEL_API_KEY=model-secret Authorization: Bearer sk-secret",
      password: "password-secret",
      objectKey: "private/object.md"
    });

    const serialized = JSON.stringify(calls);
    expect(serialized).toContain("MODEL_API_KEY=<redacted>");
    expect(serialized).toContain("Authorization: Bearer <redacted>");
    expect(serialized).not.toContain("model-secret");
    expect(serialized).not.toContain("sk-secret");
    expect(serialized).not.toContain("password-secret");
    expect(serialized).not.toContain("private/object.md");
  });

  it("removes storage-vNext physical identities from structured diagnostics", () => {
    const { calls, sink } = createSink();
    const logger = createRuntimeLogger({ logging: { level: "debug" } }, sink);

    logger.error("storage.public_boundary_failed", {
      message: [
        "objectKey=private-object-key",
        "checksumSha256=private-checksum",
        "indexUid=private-index-uid",
        "taskUid=private-task-uid",
        "tableName=private-table-name",
        "ownerRow=private-owner-row",
        "leaseToken=private-lease",
        "generationDetails=private-generation-detail",
        "cleanupObjectKey=private-cleanup-key"
      ].join(" "),
      checksumSha256: "private-checksum",
      indexUid: "private-index-uid",
      taskUid: "private-task-uid",
      tableName: "private-table-name",
      ownerRow: "private-owner-row",
      leaseToken: "private-lease"
    });

    const serialized = JSON.stringify(calls);
    for (const value of [
      "private-object-key",
      "private-checksum",
      "private-index-uid",
      "private-task-uid",
      "private-table-name",
      "private-owner-row",
      "private-lease",
      "private-generation-detail",
      "private-cleanup-key"
    ]) {
      expect(serialized, value).not.toContain(value);
    }
  });

  it("writes one redacted structured JSON record per line", () => {
    const logDir = mkdtempSync(join(tmpdir(), "focowiki-logger-"));
    const { calls, sink } = createSink();

    try {
      const logger = createRuntimeLogger({
        logging: {
          level: "debug",
          file: fileConfig(logDir)
        }
      }, sink, { streamName: "api" });

      logger.info("model.request_failed", {
        errorMessage: "MODEL_API_KEY=file-secret"
      });

      expect(calls.map((call) => call.level)).toEqual(["info"]);
      const line = readFileSync(join(logDir, "focowiki-api.log"), "utf8").trim();
      const record = JSON.parse(line) as RuntimeStructuredLogRecord;
      expect(record).toMatchObject({
        level: "info",
        event: "model.request_failed",
        stream: "api",
        fields: { errorMessage: "MODEL_API_KEY=<redacted>" }
      });
      expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
      expect(line).not.toContain("file-secret");
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it("normalizes the frozen Developer OpenAPI diagnostic call at the sink boundary", () => {
    const { calls, sink } = createSink();
    const logger = createRuntimeLogger({ logging: { level: "debug" } }, sink);

    logger.error("Developer OpenAPI request failed", {
      requestId: "request-1",
      operationId: "listKnowledgeBaseTree",
      routeTemplate: "/openapi/v2/knowledge-bases/:knowledgeBaseId/tree",
      resourceContext: { knowledgeBaseId: "kb-safe" },
      errorClass: "Error",
      errorMessage: "failed at /tmp/private.ts",
      stack: null,
      durationMs: 5,
      status: 500
    });

    expect(calls[0]?.record).toMatchObject({
      event: "developer_openapi.request_failed",
      fields: {
        knowledgeBaseId: "kb-safe",
        routeTemplate: "/openapi/v2/knowledge-bases/:knowledgeBaseId/tree",
        errorMessage: "failed at <redacted-path>"
      }
    });
  });

  it("compresses rotation and enforces the per-stream file count", () => {
    const logDir = mkdtempSync(join(tmpdir(), "focowiki-logger-"));
    const { sink } = createSink();

    try {
      const logger = createRuntimeLogger({
        logging: {
          level: "debug",
          file: {
            directory: logDir,
            maxBytes: 320,
            maxFiles: 2,
            maxTotalBytes: 640,
            retentionDays: 7
          }
        }
      }, sink, { streamName: "migrate" });

      for (let index = 0; index < 12; index += 1) {
        logger.info("migration.progress", {
          sequence: index,
          message: `${randomUUID()}-${"x".repeat(80)}`
        });
      }

      const files = readdirSync(logDir)
        .filter((file) => file.startsWith("focowiki-migrate"))
        .sort();
      expect(files).toEqual([
        "focowiki-migrate.1.log.gz",
        "focowiki-migrate.log"
      ]);
      const rotated = gunzipSync(
        readFileSync(join(logDir, "focowiki-migrate.1.log.gz"))
      ).toString("utf8");
      expect(() => JSON.parse(rotated.trim())).not.toThrow();
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it("deletes expired files and trims compressed history to the total-byte cap", () => {
    const logDir = mkdtempSync(join(tmpdir(), "focowiki-logger-"));
    const oldPath = join(logDir, "focowiki-api.1.log.gz");
    writeFileSync(oldPath, gzipSync('{"event":"old"}\n'));
    const oldTime = new Date(Date.now() - 3 * 86_400_000);
    utimesSync(oldPath, oldTime, oldTime);
    const { sink } = createSink();

    try {
      const logger = createRuntimeLogger({
        logging: {
          level: "debug",
          file: {
            directory: logDir,
            maxBytes: 320,
            maxFiles: 5,
            maxTotalBytes: 420,
            retentionDays: 1
          }
        }
      }, sink, { streamName: "api" });

      for (let index = 0; index < 20; index += 1) {
        logger.warn("runtime.bounded_failure", {
          sequence: index,
          errorMessage: `${randomUUID()}-${"y".repeat(100)}`
        });
      }

      const files = readdirSync(logDir)
        .filter((file) => file.startsWith("focowiki-api"));
      const totalBytes = files.reduce(
        (total, file) => total + statSync(join(logDir, file)).size,
        0
      );
      expect(totalBytes).toBeLessThanOrEqual(420);
      expect(files).not.toContain("focowiki-api.4.log.gz");
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it("uses a valid minimal JSON record when one event exceeds the per-file cap", () => {
    const logDir = mkdtempSync(join(tmpdir(), "focowiki-logger-"));
    const { sink } = createSink();
    try {
      const logger = createRuntimeLogger({
        logging: {
          level: "debug",
          file: {
            directory: logDir,
            maxBytes: 256,
            maxFiles: 2,
            maxTotalBytes: 512,
            retentionDays: 7
          }
        }
      }, sink, { streamName: "api" });
      logger.error("runtime.large_failure", { errorMessage: "z".repeat(2_000) });

      const line = readFileSync(join(logDir, "focowiki-api.log"), "utf8").trim();
      expect(JSON.parse(line)).toMatchObject({
        event: "runtime.log_record_too_large",
        fields: { code: "LOG_RECORD_TOO_LARGE" }
      });
      expect(Buffer.byteLength(`${line}\n`)).toBeLessThanOrEqual(256);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it("reports file logging failures without leaking secrets or local paths", () => {
    const { calls, sink } = createSink();
    const logger = createRuntimeLogger({
      logging: {
        level: "debug",
        file: {
          directory: "/dev/null/secret-dir",
          maxBytes: 10_485_760,
          maxFiles: 5,
          maxTotalBytes: 1_073_741_824,
          retentionDays: 7
        }
      }
    }, sink, { streamName: "api" });

    logger.info("storage.request_failed", {
      errorMessage: "S3_SECRET_ACCESS_KEY=storage-secret"
    });

    const serialized = JSON.stringify(calls);
    expect(serialized).toContain("runtime.file_logging_failed");
    expect(serialized).toContain("S3_SECRET_ACCESS_KEY=<redacted>");
    expect(serialized).not.toContain("storage-secret");
    expect(serialized).not.toContain("/dev/null/secret-dir");
  });
});

function fileConfig(directory: string) {
  return {
    directory,
    maxBytes: 10_485_760,
    maxFiles: 5,
    maxTotalBytes: 1_073_741_824,
    retentionDays: 7
  };
}
