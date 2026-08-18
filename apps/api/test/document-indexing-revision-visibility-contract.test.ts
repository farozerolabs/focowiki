import { describe, expect, it } from "vitest";

type VisibilitySurface =
  | "tree"
  | "content"
  | "graph"
  | "generated_page"
  | "search";

type CanExposeRevisionArtifact = (input: {
  surface: VisibilitySurface;
  artifactSourceRevisionPublicId: string;
  activeSourceRevisionPublicId: string | null;
  documentState:
    | "waiting"
    | "processing"
    | "available"
    | "error"
    | "deleting"
    | "cancelled"
    | "superseded";
  sourceDeletedAt: string | null;
  bodyReadable: boolean;
}) => boolean;

const surfaces = [
  "tree",
  "content",
  "graph",
  "generated_page",
  "search"
] as const;

describe("document indexing revision visibility contract", () => {
  it.each(surfaces)("shows a current available revision on %s", async (surface) => {
    const canExpose = await loadVisibilityPolicy();

    expect(canExpose(facts(surface))).toBe(true);
  });

  it.each([
    ["inactive", { artifactSourceRevisionPublicId: "revision-old" }],
    ["failed", { documentState: "error" }],
    ["deleted", {
      documentState: "deleting",
      sourceDeletedAt: "2026-08-14T00:00:03.000Z"
    }],
    ["cancelled", { documentState: "cancelled" }],
    ["superseded", { documentState: "superseded" }],
    ["unreadable", { bodyReadable: false }]
  ] as const)(
    "excludes every %s revision artifact from every public surface",
    async (_, override) => {
      const canExpose = await loadVisibilityPolicy();

      for (const surface of surfaces) {
        expect(canExpose({ ...facts(surface), ...override })).toBe(false);
      }
    }
  );
});

function facts(surface: VisibilitySurface) {
  return {
    surface,
    artifactSourceRevisionPublicId: "revision-current",
    activeSourceRevisionPublicId: "revision-current",
    documentState: "available" as const,
    sourceDeletedAt: null,
    bodyReadable: true
  };
}

async function loadVisibilityPolicy(): Promise<CanExposeRevisionArtifact> {
  const moduleUrl = new URL(
    "../src/document-indexing/domain/revision-visibility.ts",
    import.meta.url
  ).href;
  const loaded = await import(/* @vite-ignore */ moduleUrl) as {
    canExposeRevisionArtifact: CanExposeRevisionArtifact;
  };
  return loaded.canExposeRevisionArtifact;
}
