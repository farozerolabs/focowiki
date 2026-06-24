import { describe, expect, it } from "vitest";
import type { RuntimeLogger } from "../src/logger.js";
import { logReadLatency } from "../src/read-latency-logger.js";

describe("read latency logger", () => {
  it("logs safe endpoint classes without raw resource identifiers", () => {
    const entries: unknown[][] = [];
    const logger: RuntimeLogger = {
      error: (...parts) => entries.push(parts),
      warn: (...parts) => entries.push(parts),
      info: (...parts) => entries.push(parts),
      debug: (...parts) => entries.push(parts)
    };

    logReadLatency({
      logger,
      method: "GET",
      path: "/admin/api/knowledge-bases/kb-secret/source-files",
      status: 200,
      durationMs: 12.4
    });

    expect(entries).toEqual([
      [
        "API read request completed",
        {
          plane: "admin",
          endpoint: "source_file_list",
          status: 200,
          durationMs: 12
        }
      ]
    ]);
    expect(JSON.stringify(entries)).not.toContain("kb-secret");
  });

  it("ignores write requests and unrelated endpoints", () => {
    const entries: unknown[][] = [];
    const logger: RuntimeLogger = {
      error: (...parts) => entries.push(parts),
      warn: (...parts) => entries.push(parts),
      info: (...parts) => entries.push(parts),
      debug: (...parts) => entries.push(parts)
    };

    logReadLatency({
      logger,
      method: "POST",
      path: "/admin/api/knowledge-bases",
      status: 201,
      durationMs: 4
    });

    expect(entries).toEqual([]);
  });
});
