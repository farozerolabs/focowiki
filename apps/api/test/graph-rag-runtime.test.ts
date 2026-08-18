import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GRAPHRAG_RESPONSE_SCHEMA,
  type GraphRagAdapterResponse
} from "../src/semantic/graphrag/contracts.js";
import {
  assertSupportedNodeVersion,
  createGraphRagRuntime,
  resolveGraphRagPoolSize,
  resolvePythonPath
} from "../src/semantic/graphrag/graph-rag-runtime.js";
import type { GraphRagPythonProcess } from "../src/semantic/graphrag/python-process.js";

describe("GraphRAG unified-worker runtime", () => {
  it("bounds the Python pool by measured source concurrency", () => {
    expect(resolveGraphRagPoolSize(1)).toBe(1);
    expect(resolveGraphRagPoolSize(2)).toBe(2);
    expect(resolveGraphRagPoolSize(4)).toBe(2);
    expect(resolveGraphRagPoolSize(16)).toBe(2);
    expect(resolveGraphRagPoolSize(24)).toBe(3);
    expect(resolveGraphRagPoolSize(32)).toBe(4);
    expect(() => resolveGraphRagPoolSize(0)).toThrow("sourceConcurrency");
    expect(() => resolveGraphRagPoolSize(33)).toThrow("sourceConcurrency");
  });

  it("validates Node and adapter paths before semantic claims", async () => {
    expect(() => assertSupportedNodeVersion("22.0.0")).toThrow("Node.js 24");
    expect(resolvePythonPath(resolve(import.meta.dirname, "../../.."))).toMatch(/apps\/api\/python$/u);
    const events: string[] = [];
    const runtime = createGraphRagRuntime({
      workingDirectory: resolve(import.meta.dirname, "../../.."),
      nodeVersion: "24.1.0",
      poolSize: 2,
      createChild: () => fakeChild(events)
    });
    await runtime.start();
    expect(events).toEqual(["health", "health"]);
    expect(runtime.pool.stats()).toMatchObject({ size: 2, busy: 0 });
    await runtime.close();
    expect(events.filter((event) => event === "terminate")).toHaveLength(2);
  });

  it("fails startup when one pinned adapter contract is incompatible", async () => {
    const runtime = createGraphRagRuntime({
      workingDirectory: resolve(import.meta.dirname, "../../.."),
      nodeVersion: "24.1.0",
      createChild: () => ({
        pid: 1,
        request: async (request): Promise<GraphRagAdapterResponse> => ({
          schemaVersion: GRAPHRAG_RESPONSE_SCHEMA,
          requestId: request.requestId,
          ok: false,
          error: { code: "GRAPHRAG_VERSION_MISMATCH", message: "version mismatch" }
        }),
        terminate() {}
      })
    });
    await expect(runtime.start()).rejects.toMatchObject({ code: "ADAPTER_HEALTH_FAILED" });
  });
});

function fakeChild(events: string[]): GraphRagPythonProcess {
  return {
    pid: events.length + 1,
    async request(request) {
      events.push(request.operation);
      return {
        schemaVersion: GRAPHRAG_RESPONSE_SCHEMA,
        requestId: request.requestId,
        ok: true,
        result: { graphragVersion: "3.1.1" }
      };
    },
    terminate() {
      events.push("terminate");
    }
  };
}
