import { describe, expect, it } from "vitest";
import {
  normalizeDurableGraphReason,
  presentGraphRelationship
} from "../src/graph-presentation.js";

const edge = {
  from: {
    fileId: "source-file-a",
    path: "pages/manuals/setup.md",
    title: "Setup guide"
  },
  to: {
    fileId: "source-file-b",
    path: "pages/reference/runtime.md",
    title: "Runtime reference"
  },
  relationType: "prerequisite",
  weight: 0.92,
  reason: "The setup workflow depends on the runtime configuration described in Runtime reference.",
  source: "model_confirmed" as const,
  evidence: {
    sharedSubjects: ["runtime configuration"]
  }
};

describe("graph relationship presentation", () => {
  it("presents an outgoing edge from the current file", () => {
    expect(presentGraphRelationship(edge, "source-file-a")).toEqual({
      fileId: "source-file-b",
      path: "pages/reference/runtime.md",
      title: "Runtime reference",
      relationType: "prerequisite",
      direction: "outgoing",
      weight: 0.92,
      reason:
        'From "Setup guide" to "Runtime reference": The setup workflow depends on the runtime configuration described in Runtime reference.',
      source: "model_confirmed",
      evidence: {
        sharedSubjects: ["runtime configuration"]
      }
    });
  });

  it("presents the same canonical edge as incoming for the target file", () => {
    expect(presentGraphRelationship(edge, "source-file-b")).toMatchObject({
      fileId: "source-file-a",
      path: "pages/manuals/setup.md",
      title: "Setup guide",
      direction: "incoming",
      reason:
        'Incoming from "Setup guide" to "Runtime reference": The setup workflow depends on the runtime configuration described in Runtime reference.'
    });
  });

  it("adds endpoint wording only while presenting a durable fact", () => {
    const relationship = presentGraphRelationship(
      {
        ...edge,
        reason: "Both files describe the same runtime configuration."
      },
      "source-file-a"
    );

    expect(relationship.reason).toBe(
      'From "Setup guide" to "Runtime reference": Both files describe the same runtime configuration.'
    );
    expect(relationship.reason.match(/Setup guide/gu)).toHaveLength(1);
    expect(relationship.reason.match(/Runtime reference/gu)).toHaveLength(1);
  });

  it("rejects presentation when the current file is not an edge endpoint", () => {
    expect(() => presentGraphRelationship(edge, "source-file-c")).toThrow(
      /graph edge endpoint/u
    );
  });

  it("bounds nested evidence without mutating the stored edge", () => {
    const oversizedEvidence = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [
        `key-${index}`,
        ["x".repeat(800), ...Array.from({ length: 20 }, () => "extra")]
      ])
    );
    const relationship = presentGraphRelationship(
      { ...edge, evidence: oversizedEvidence },
      "source-file-a"
    );

    expect(Object.keys(relationship.evidence ?? {})).toHaveLength(16);
    expect((relationship.evidence?.["key-0"] as string[])).toHaveLength(16);
    expect((relationship.evidence?.["key-0"] as string[])[0]).toHaveLength(500);
    expect(Object.keys(oversizedEvidence)).toHaveLength(20);
  });

  it("normalizes durable reasons to named endpoints and rejects deictic model wording", () => {
    expect(
      normalizeDurableGraphReason({
        reason: "The current file refers to the target file.",
        fallbackReason: "The setup steps depend on the runtime configuration."
      })
    ).toBe("The setup steps depend on the runtime configuration.");
  });

  it("stores an accepted model reason as a direction-neutral fact", () => {
    expect(
      normalizeDurableGraphReason({
        reason: "Both files describe the same runtime configuration.",
        fallbackReason: "The connected Markdown content contains accepted relationship evidence."
      })
    ).toBe("Both files describe the same runtime configuration.");
  });
});
