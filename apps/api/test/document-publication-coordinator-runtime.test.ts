import { describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { createProductionDocumentPublicationCoordinatorRuntime } from
  "../src/document-indexing/infrastructure/production-document-publication-coordinator-runtime.js";

describe("document publication coordinator runtime", () => {
  it("isolates an iteration failure without terminating the worker lane",
    async () => {
      const failure = Object.assign(new Error("generation collision"), {
        code: "23505"
      });
      const sql = (() => Promise.reject(failure)) as unknown as DatabaseClient;
      sql.begin = async () => { throw failure; };
      const controller = new AbortController();
      const errors: unknown[] = [];
      const runtime = createProductionDocumentPublicationCoordinatorRuntime({
        sql,
        idlePollMilliseconds: 1,
        onError(error) {
          errors.push(error);
          controller.abort();
        }
      });

      await expect(runtime.run(controller.signal)).resolves.toBeUndefined();
      expect(errors).toEqual([failure]);
    });
});
