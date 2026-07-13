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

  it("classifies current Developer OpenAPI v2 reads and ignores removed v1 paths", () => {
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
      path: "/openapi/v2/knowledge-bases/kb-current/source-files",
      status: 200,
      durationMs: 18.6
    });
    logReadLatency({
      logger,
      method: "GET",
      path: "/openapi/v2/knowledge-bases/kb-current/tree",
      status: 200,
      durationMs: 21.2
    });
    logReadLatency({
      logger,
      method: "GET",
      path: "/openapi/v1/knowledge-bases/kb-removed/source-files",
      status: 200,
      durationMs: 1
    });

    expect(entries).toEqual([
      [
        "API read request completed",
        {
          plane: "developer_openapi",
          endpoint: "source_file_list",
          status: 200,
          durationMs: 19
        }
      ],
      [
        "API read request completed",
        {
          plane: "developer_openapi",
          endpoint: "file_tree",
          status: 200,
          durationMs: 21
        }
      ]
    ]);
  });
});
