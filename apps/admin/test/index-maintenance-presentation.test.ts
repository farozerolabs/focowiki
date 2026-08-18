import { describe, expect, it } from "vitest";
import { indexMaintenanceFailureLabel } from
  "../src/lib/index-maintenance-presentation.js";

describe("index maintenance presentation", () => {
  it("presents a safe actionable failure when only a backend error code exists", () => {
    const translate = (key: string) => `translated:${key}`;

    expect(indexMaintenanceFailureLabel(
      "MAINTENANCE_PHASE_FAILED",
      null,
      translate
    )).toBe("translated:indexMaintenance.failures.general");
  });
});
