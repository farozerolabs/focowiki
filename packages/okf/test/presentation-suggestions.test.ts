import { describe, expect, it } from "vitest";

import { resolvePresentationMetadata } from "../src/presentation-suggestions.js";

describe("resolvePresentationMetadata", () => {
  it("preserves a meaningful producer description", () => {
    const metadata = resolvePresentationMetadata({
      metadata: {
        type: "Guide",
        title: "Operations guide",
        description: "Explains the deployment and rollback workflow."
      },
      suggestions: {
        description: "Generated replacement that must not win."
      },
      body: "# Operations guide\n\nThis document covers deployment and rollback.",
      fileName: "operations-guide.md"
    });

    expect(metadata.description).toBe("Explains the deployment and rollback workflow.");
  });

  it.each([
    undefined,
    "Operations guide",
    "  Operations   guide。 "
  ])("uses a body-grounded suggestion for a missing or title-equivalent description", (description) => {
    const metadata = resolvePresentationMetadata({
      metadata: {
        type: "Guide",
        title: "Operations guide",
        ...(description === undefined ? {} : { description })
      },
      suggestions: {
        description: "Summarizes deployment prerequisites, rollout steps, and rollback checks."
      },
      body: "# Operations guide\n\nDeployment requires a verified backup before rollout.",
      fileName: "operations-guide.md"
    });

    expect(metadata.description).toBe(
      "Summarizes deployment prerequisites, rollout steps, and rollback checks."
    );
  });

  it("uses one bounded source paragraph when no valid suggestion exists", () => {
    const longTail = "x".repeat(400);
    const metadata = resolvePresentationMetadata({
      metadata: {
        type: "Guide",
        title: "Operations guide",
        description: "Operations guide"
      },
      suggestions: { description: "\u0000unsafe" },
      body: [
        "# Operations guide",
        "",
        "Deployment requires a verified backup and a tested rollback plan.",
        "",
        longTail
      ].join("\n"),
      fileName: "operations-guide.md"
    });

    expect(metadata.description).toBe(
      "Deployment requires a verified backup and a tested rollback plan."
    );
  });

  it("leaves description absent when no safe evidence exists", () => {
    const metadata = resolvePresentationMetadata({
      metadata: {
        type: "Guide",
        title: "Operations guide"
      },
      suggestions: { description: "" },
      body: "# Operations guide\n\n- item\n- item",
      fileName: "operations-guide.md"
    });

    expect(metadata).not.toHaveProperty("description");
  });

  it("does not treat a filename-equivalent description as meaningful", () => {
    const metadata = resolvePresentationMetadata({
      metadata: {
        type: "Guide",
        title: "Deployment",
        description: "operations-guide"
      },
      suggestions: {
        description: "Explains deployment checks for operators."
      },
      body: "# Deployment\n\nOperators verify the service before rollout.",
      fileName: "operations-guide.md"
    });

    expect(metadata.description).toBe("Explains deployment checks for operators.");
  });

  it("rejects a model description written in a different dominant script from the source body", () => {
    const metadata = resolvePresentationMetadata({
      metadata: {
        type: "Guide",
        title: "Deployment guide",
        description: "Deployment guide"
      },
      suggestions: {
        description:
          "\u042d\u0442\u043e \u0440\u0443\u043a\u043e\u0432\u043e\u0434\u0441\u0442\u0432\u043e \u043e\u043f\u0438\u0441\u044b\u0432\u0430\u0435\u0442 \u043f\u0440\u0435\u0434\u0432\u0430\u0440\u0438\u0442\u0435\u043b\u044c\u043d\u044b\u0435 \u0443\u0441\u043b\u043e\u0432\u0438\u044f \u0440\u0430\u0437\u0432\u0435\u0440\u0442\u044b\u0432\u0430\u043d\u0438\u044f, \u043f\u0440\u043e\u0432\u0435\u0440\u043a\u0438 \u0432\u044b\u043f\u0443\u0441\u043a\u0430 \u0438 \u043f\u0440\u043e\u0446\u0435\u0434\u0443\u0440\u044b \u043e\u0442\u043a\u0430\u0442\u0430."
      },
      body: "# Deployment guide\n\nThis guide explains deployment prerequisites, rollout checks, rollback procedures, and operational responsibilities.",
      fileName: "deployment-guide.md"
    });

    expect(metadata.description).toBe(
      "This guide explains deployment prerequisites, rollout checks, rollback procedures, and operational responsibilities."
    );
  });
});
