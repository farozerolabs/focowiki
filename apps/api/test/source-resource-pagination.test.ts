import { describe, expect, it, vi } from "vitest";
import {
  readSourceResourceCursor,
  sourceResourceCursorScope,
  writeSourceResourceCursor
} from "../src/developer-openapi/source-resource-pagination.js";

describe("source resource pagination", () => {
  it("rejects unknown opaque cursors", async () => {
    const redis = {
      getPaginationCursor: vi.fn().mockResolvedValue(null)
    };

    await expect(
      readSourceResourceCursor(redis as never, "source-files", "not-a-cursor")
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("round-trips repository cursors within a stable query scope", async () => {
    const stored = new Map<string, unknown>();
    const redis = {
      setPaginationCursor: vi.fn(async (
        scope: string,
        cursorId: string,
        value: unknown
      ) => {
        stored.set(`${scope}:${cursorId}`, value);
      }),
      getPaginationCursor: vi.fn(async (scope: string, cursorId: string) =>
        stored.get(`${scope}:${cursorId}`) ?? null
      )
    };
    const scope = sourceResourceCursorScope("files", "knowledge-base", {
      directoryId: "directory",
      filters: { state: "visible" }
    });
    const cursor = await writeSourceResourceCursor(
      redis as never,
      scope,
      "source-file-next",
      900
    );

    await expect(
      readSourceResourceCursor(redis as never, scope, cursor)
    ).resolves.toBe("source-file-next");
    await expect(
      readSourceResourceCursor(
        redis as never,
        sourceResourceCursorScope("files", "knowledge-base", {
          directoryId: "different",
          filters: { state: "visible" }
        }),
        cursor
      )
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
