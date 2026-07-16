import { describe, expect, it } from "vitest";
import {
  createSourceFileJobPayload,
  parseSourceFileJobPayload,
  resolveSourceFilePublicationEligibility
} from "../src/domain/source-file-job.js";

describe("source-file worker job payload", () => {
  it.each(["upload", "retry", "resource_operation"] as const)(
    "accepts the final %s reason",
    (reason) => {
      expect(createSourceFileJobPayload(reason)).toEqual({ reason });
      expect(parseSourceFileJobPayload({ reason })).toEqual({ reason });
    }
  );

  it.each([
    {},
    { reason: "unknown" },
    { reason: "upload", legacy: true },
    { reason: null },
    []
  ])("rejects obsolete or invalid source-file payload %#", (payload) => {
    expect(() => parseSourceFileJobPayload(payload)).toThrow(/source-file worker job payload/iu);
  });

  it("reserves immediate publication eligibility for resource operations", () => {
    expect(resolveSourceFilePublicationEligibility("upload")).toBe("import");
    expect(resolveSourceFilePublicationEligibility("retry")).toBe("import");
    expect(resolveSourceFilePublicationEligibility("resource_operation")).toBe("interactive");
  });
});
