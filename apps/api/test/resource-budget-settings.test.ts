import { describe, expect, it } from "vitest";
import { resolveResourceBudgetLimits } from "../src/runtime-settings/resource-budget-settings.js";

describe("resource budget settings", () => {
  it("maps only concurrency fields with live process budgets", () => {
    const limits = resolveResourceBudgetLimits({
      publication: {
        generatedObjectWriteConcurrency: 6
      },
      activeModel: { suggestionConcurrency: 4 }
    } as never);

    expect(limits).toMatchObject({
      model: 4,
      generatedObjectWrite: 6
    });
  });
});
