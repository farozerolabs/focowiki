import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("storage vNext Admin processing summary contract", () => {
  it("counts mutation work in the publication-plane queue card", () => {
    const source = readFileSync(resolve(
      import.meta.dirname,
      "../src/storage-vnext/api/postgres-admin-processing.ts"
    ), "utf8");

    expect(source).toMatch(
      /queueSummary\(\s*queues,\s*\["publication", "search", "mutation"\],\s*now\s*\)/u
    );
  });
});
