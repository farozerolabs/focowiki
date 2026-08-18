import { createHash } from "node:crypto";

export function writeAttempt(jobPublicId: string, kind: string): string {
  return `write-${digest([jobPublicId, kind])}`;
}

export function immutableArtifactWriteAttempt(
  ownerPublicId: string,
  purpose: string,
  checksumSha256: string
): string {
  return writeAttempt(ownerPublicId, [purpose, checksumSha256].join("-"));
}

export function generatedPageWriteAttempt(
  ownerPublicId: string,
  purpose: "generated-page" | "deletion-page",
  baseRevision: number,
  normalizedPath: string,
  checksumSha256: string
): string {
  return writeAttempt(ownerPublicId, [
    purpose,
    String(baseRevision),
    normalizedPath,
    checksumSha256
  ].join("-"));
}

export function ownerIdentity(ownerPublicId: string, objectId: string): string {
  return `object-owner-${digest([ownerPublicId, objectId])}`;
}

export function digest(values: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

export function now(): string {
  return new Date().toISOString();
}

export function processorError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document processor error: ${code}`), { code });
}
