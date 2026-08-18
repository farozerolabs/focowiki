import { describe, expect, it, vi } from "vitest";
import { createUnifiedBackgroundClaim } from
  "../src/document-indexing/application/unified-worker-scheduler.js";
import { UNIFIED_BACKGROUND_WORK_CLASSES } from
  "../src/document-indexing/application/unified-worker-scheduler.js";

describe("unified worker background scheduler", () => {
  it("owns interactive mutation work as a canonical class", () => {
    expect(UNIFIED_BACKGROUND_WORK_CLASSES[0]).toBe("mutation");
  });

  it("keeps deletion ahead while guaranteeing maintenance a bounded turn", async () => {
    let mutation = 0;
    let deletion = 0;
    let maintenance = 0;
    const claim = createUnifiedBackgroundClaim({
      schedule: [
        "mutation", "mutation", "deletion", "deletion",
        "maintenance", "orphan"
      ],
      sources: {
        mutation: async () => [{ publicId: `mutation-${mutation += 1}` }],
        deletion: async () => [{ publicId: `deletion-${deletion += 1}` }],
        maintenance: async () => [{ publicId: `maintenance-${maintenance += 1}` }],
        orphan: async () => []
      }
    });

    const classes = [];
    for (let index = 0; index < 10; index += 1) {
      classes.push((await claim(1))[0]?.workClass);
    }
    expect(classes).toEqual([
      "mutation", "mutation", "deletion", "deletion", "maintenance",
      "mutation", "mutation", "deletion", "deletion", "maintenance"
    ]);
  });

  it("borrows empty class turns without reducing available cleanup capacity", async () => {
    let orphan = 0;
    const deletion = vi.fn().mockResolvedValue([]);
    const claim = createUnifiedBackgroundClaim({
      schedule: ["mutation", "deletion", "maintenance", "orphan"],
      sources: {
        mutation: async () => [],
        deletion,
        maintenance: async () => [],
        orphan: async () => [{ publicId: `orphan-${orphan += 1}` }]
      }
    });

    await expect(claim(2)).resolves.toEqual([
      { publicId: "orphan-1", workClass: "orphan" },
      { publicId: "orphan-2", workClass: "orphan" }
    ]);
    expect(deletion).toHaveBeenCalled();
  });

  it("rejects duplicate durable identities returned by different work classes", async () => {
    const claim = createUnifiedBackgroundClaim({
      schedule: ["mutation", "deletion", "maintenance", "orphan"],
      sources: {
        mutation: async () => [],
        deletion: async () => [{ publicId: "same-work" }],
        maintenance: async () => [{ publicId: "same-work" }],
        orphan: async () => []
      }
    });

    await expect(claim(2)).rejects.toThrow("duplicate durable identity");
  });
});
