import { assertNoSensitiveEvidence } from "./comprehensive-release-evidence.mjs";

const PROHIBITED_PATH_PATTERNS = Object.freeze([
  /^ReferenceDocs\//u,
  /(?:^|\/)screenshots?\//iu,
  /(?:^|\/)corpus(?:\/|$)/iu,
  /(?:^|\/)raw-evidence(?:\/|$)/iu,
  /(?:^|\/)\.env$/u,
  /(?:^|\/)validation-secrets?(?:\/|$)/iu
]);

export function assertSafeStagedArtifacts(artifacts) {
  if (!Array.isArray(artifacts)) throw new Error("Staged artifact inventory is missing");
  for (const artifact of artifacts) {
    const artifactPath = String(artifact?.path ?? "");
    if (
      !artifactPath
      || artifact.ignored === true
      || PROHIBITED_PATH_PATTERNS.some((pattern) => pattern.test(artifactPath))
    ) {
      throw new Error(`Unsafe staged artifact: ${artifactPath || "unknown"}`);
    }
    assertNoSensitiveEvidence({ stagedContent: String(artifact.content ?? "") });
  }
}
