import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeLogger } from "../src/logger.js";

type SinkCall = {
  level: "error" | "warn" | "info" | "debug";
  parts: unknown[];
};

function createSink() {
  const calls: SinkCall[] = [];

  return {
    calls,
    sink: {
      error(...parts: unknown[]) {
        calls.push({ level: "error", parts });
      },
      warn(...parts: unknown[]) {
        calls.push({ level: "warn", parts });
      },
      info(...parts: unknown[]) {
        calls.push({ level: "info", parts });
      },
      debug(...parts: unknown[]) {
        calls.push({ level: "debug", parts });
      }
    }
  };
}

describe("createRuntimeLogger", () => {
  it("filters log calls below the configured level", () => {
    const { calls, sink } = createSink();
    const logger = createRuntimeLogger({ logging: { level: "warn" } }, sink);

    logger.debug("debug details");
    logger.info("startup");
    logger.warn("slow request");
    logger.error("failed request");

    expect(calls.map((call) => call.level)).toEqual(["warn", "error"]);
  });

  it("redacts secrets before writing log output", () => {
    const { calls, sink } = createSink();
    const logger = createRuntimeLogger({ logging: { level: "debug" } }, sink);

    logger.error("MODEL_API_KEY=model-secret", {
      nested: "Authorization: Bearer sk-secret"
    });

    expect(JSON.stringify(calls)).toContain("MODEL_API_KEY=<redacted>");
    expect(JSON.stringify(calls)).toContain("Authorization: Bearer <redacted>");
    expect(JSON.stringify(calls)).not.toContain("model-secret");
    expect(JSON.stringify(calls)).not.toContain("sk-secret");
  });

  it("writes redacted logs to files and keeps console output", () => {
    const logDir = mkdtempSync(join(tmpdir(), "focowiki-logger-"));
    const { calls, sink } = createSink();

    try {
      const logger = createRuntimeLogger(
        {
          logging: {
            level: "debug",
            file: {
              directory: logDir,
              maxBytes: 10_485_760,
              maxFiles: 5
            }
          }
        },
        sink,
        {
          streamName: "api"
        }
      );

      logger.info("MODEL_API_KEY=file-secret");

      expect(calls.map((call) => call.level)).toEqual(["info"]);
      const logFile = readFileSync(join(logDir, "focowiki-api.log"), "utf8");
      expect(logFile).toContain("MODEL_API_KEY=<redacted>");
      expect(logFile).not.toContain("file-secret");
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it("rotates file logs and deletes old files beyond the configured maximum", () => {
    const logDir = mkdtempSync(join(tmpdir(), "focowiki-logger-"));
    const { sink } = createSink();

    try {
      const logger = createRuntimeLogger(
        {
          logging: {
            level: "debug",
            file: {
              directory: logDir,
              maxBytes: 120,
              maxFiles: 2
            }
          }
        },
        sink,
        {
          streamName: "migrate"
        }
      );

      for (let index = 0; index < 12; index += 1) {
        logger.info(`rotation-message-${index.toString().padStart(2, "0")}`);
      }

      const files = readdirSync(logDir)
        .filter((file) => file.startsWith("focowiki-migrate"))
        .sort();
      expect(files).toEqual(["focowiki-migrate.1.log", "focowiki-migrate.log"]);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it("reports file logging failures without leaking secrets", () => {
    const { calls, sink } = createSink();
    const logger = createRuntimeLogger(
      {
        logging: {
          level: "debug",
          file: {
            directory: "/dev/null/secret-dir",
            maxBytes: 10_485_760,
            maxFiles: 5
          }
        }
      },
      sink,
      {
        streamName: "api"
      }
    );

    logger.info("S3_SECRET_ACCESS_KEY=storage-secret");

    const serialized = JSON.stringify(calls);
    expect(serialized).toContain("Runtime file logging failed");
    expect(serialized).toContain("S3_SECRET_ACCESS_KEY=<redacted>");
    expect(serialized).not.toContain("storage-secret");
  });
});
