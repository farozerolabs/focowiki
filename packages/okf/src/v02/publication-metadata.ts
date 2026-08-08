import { normalizeOkfDateTime } from "./dates.js";
import type {
  OkfPublicationMetadataInput
} from "./types.js";

export function buildOkfPublicationMetadata(
  input: OkfPublicationMetadataInput
): OkfPublicationMetadataInput["metadata"] {
  const metadata = structuredClone(input.metadata);
  if (input.ownership === "source") return metadata;
  if (input.artifactKind === "bundle_root") {
    return { okf_version: "0.2" };
  }
  const changedAt = normalizeOkfDateTime(input.changedAt);
  if (changedAt === null) {
    throw new Error("Focowiki publication metadata requires a valid changedAt instant");
  }
  return {
    ...metadata,
    generated: {
      by: "process:focowiki-publication",
      at: changedAt
    }
  };
}
