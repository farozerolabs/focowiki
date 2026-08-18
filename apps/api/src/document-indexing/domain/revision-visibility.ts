export const DOCUMENT_VISIBILITY_SURFACES = [
  "tree",
  "content",
  "graph",
  "generated_page",
  "search"
] as const;

export type DocumentVisibilitySurface =
  (typeof DOCUMENT_VISIBILITY_SURFACES)[number];

export function canExposeRevisionArtifact(input: {
  surface: DocumentVisibilitySurface;
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
}): boolean {
  return DOCUMENT_VISIBILITY_SURFACES.includes(input.surface)
    && input.documentState === "available"
    && input.sourceDeletedAt === null
    && input.bodyReadable
    && input.activeSourceRevisionPublicId !== null
    && input.artifactSourceRevisionPublicId
      === input.activeSourceRevisionPublicId;
}
