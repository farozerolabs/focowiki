import { createHash } from "node:crypto";
import type { DocumentPublicationJobOutput } from
  "./document-publication-job-ports.js";

export function fingerprintDocumentPublicationOutputs(
  outputs: readonly DocumentPublicationJobOutput[]
): string {
  return createHash("sha256").update(
    canonicalDocumentPublicationValue(outputs)
  ).digest("hex");
}

export function canonicalDocumentPublicationValue(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalDocumentPublicationValue).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => bytewise(left, right))
    .map(([key, item]) => `${JSON.stringify(key)}:${
      canonicalDocumentPublicationValue(item)
    }`)
    .join(",")}}`;
}

function bytewise(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
