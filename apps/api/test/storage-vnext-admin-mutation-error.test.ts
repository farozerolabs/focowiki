import { describe, expect, it } from "vitest";
import { mapStorageVnextMutationError } from
  "../src/storage-vnext/api/postgres-admin-mutation.js";

describe("storage vNext mutation API errors", () => {
  it("maps unchanged replacement content to its truthful public conflict", () => {
    const error = Object.assign(new Error("unchanged"), { code: "content_unchanged" });
    expect(mapStorageVnextMutationError(error)).toMatchObject({
      code: "RESOURCE_CONTENT_UNCHANGED"
    });
  });
});
