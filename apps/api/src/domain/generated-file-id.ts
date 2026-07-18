import { createHash } from "node:crypto";

export function createGeneratedFileId(input: {
  refKind: string;
  refKey: string;
  sourceFileId: string | null;
}): string {
  if (input.refKind === "page" && input.sourceFileId) {
    return input.sourceFileId;
  }
  const digest = createHash("sha256")
    .update(`${input.refKind}\u0000${input.refKey}`)
    .digest("hex")
    .slice(0, 32);
  return `generated-file-${digest}`;
}
