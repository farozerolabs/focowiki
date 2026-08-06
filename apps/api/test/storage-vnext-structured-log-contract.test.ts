import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const loggerSource = read("apps/api/src/logger.ts");
const sinkSource = read("apps/api/src/file-log-sink.ts");
const configSource = read("apps/api/src/config.ts");

function read(path: string): string {
  return readFileSync(resolve(workspaceRoot, path), "utf8");
}

describe("storage vNext bounded structured diagnostic log contract", () => {
  it("accepts one stable event and bounded primitive safe fields", () => {
    expect(loggerSource).toContain("export type RuntimeDiagnosticFields");
    expect(loggerSource).toContain("eventName: string");
    expect(loggerSource).not.toMatch(/\.\.\.parts:\s*unknown\[\]/u);
    expect(loggerSource).not.toMatch(/Record<string,\s*unknown>/u);
  });

  it("serializes JSON lines and compresses rotated files without idle timers", () => {
    expect(sinkSource).toContain("JSON.stringify");
    expect(sinkSource).toMatch(/gzipSync|createGzip/u);
    expect(sinkSource).toContain(".log.gz");
    expect(sinkSource).not.toMatch(/setInterval|setTimeout/u);
  });

  it("enforces per-file, file-count, total-byte, and retention-day fields", () => {
    for (const field of ["maxBytes", "maxFiles", "maxTotalBytes", "retentionDays"]) {
      expect(sinkSource, field).toContain(field);
      expect(configSource, field).toContain(field);
    }
  });

  it("rejects sensitive diagnostic field families before file serialization", () => {
    for (const field of [
      "secret",
      "password",
      "credential",
      "body",
      "prompt",
      "sql",
      "object",
      "cookie",
      "path"
    ]) {
      expect(loggerSource.toLowerCase(), field).toContain(field);
    }
  });
});
