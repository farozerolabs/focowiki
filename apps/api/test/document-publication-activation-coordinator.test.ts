import { describe, expect, it, vi } from "vitest";
import { createDocumentPublicationActivationCoordinator } from
  "../src/document-indexing/application/document-publication-activation-coordinator.js";

describe("document publication activation coordinator", () => {
  it("activates every operation kind through one transaction boundary", async () => {
    const activate = vi.fn().mockResolvedValue({ headVersion: 3 });
    const coordinator = createDocumentPublicationActivationCoordinator({
      activation: { activate },
      recovery: { recoverStaleBase: vi.fn() }
    });
    for (const operation of [
      "create", "replace", "rename", "move", "delete", "repair", "cutover"
    ] as const) {
      await expect(coordinator.activate({
        operation,
        generationPublicId: `generation-${operation}`,
        expectedHeadVersion: 2,
        activatedAt: "2026-08-21T14:00:00.000Z"
      })).resolves.toEqual({ state: "active", result: { headVersion: 3 } });
    }
    expect(activate).toHaveBeenCalledTimes(7);
  });

  it("turns stale-base into durable recovery without a business retry", async () => {
    const activate = vi.fn().mockRejectedValue(Object.assign(
      new Error("stale"), { code: "publication_generation_stale_base" }
    ));
    const recoverStaleBase = vi.fn().mockResolvedValue({
      generationPublicId: "generation-stale",
      releasedFactCount: 2
    });
    const coordinator = createDocumentPublicationActivationCoordinator({
      activation: { activate },
      recovery: { recoverStaleBase }
    });
    await expect(coordinator.activate({
      operation: "replace",
      generationPublicId: "generation-stale",
      expectedHeadVersion: 1,
      activatedAt: "2026-08-21T14:01:00.000Z"
    })).resolves.toEqual({
      state: "superseded",
      recovery: { generationPublicId: "generation-stale", releasedFactCount: 2 }
    });
    expect(recoverStaleBase).toHaveBeenCalledWith({
      generationPublicId: "generation-stale",
      recoveredAt: "2026-08-21T14:01:00.000Z"
    });
  });

  it("returns durable contention deferral without invoking stale recovery",
    async () => {
      const recovery = vi.fn();
      const coordinator = createDocumentPublicationActivationCoordinator({
        activation: { activate: vi.fn().mockRejectedValue(Object.assign(
          new Error("deferred"), {
            code: "publication_activation_contention_deferred"
          }
        )) },
        recovery: { recoverStaleBase: recovery }
      });
      await expect(coordinator.activate({
        operation: "delete",
        generationPublicId: "generation-deferred",
        expectedHeadVersion: 1,
        activatedAt: "2026-08-21T14:02:00.000Z"
      })).resolves.toEqual({ state: "deferred" });
      expect(recovery).not.toHaveBeenCalled();
    });
});
