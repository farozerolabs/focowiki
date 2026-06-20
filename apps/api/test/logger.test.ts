import { describe, expect, it } from "vitest";
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
});
