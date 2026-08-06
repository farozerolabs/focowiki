import { createHash } from "node:crypto";

export function createStorageVnextUploadIdentity(
  kind: "cleanup" | "directory" | "idempotency" | "live-owner" | "source-operation",
  ...parts: readonly string[]
): string {
  const digest = createHash("sha256")
    .update(`storage-vnext-upload-${kind}-v1\0`)
    .update(parts.join("\0"))
    .digest("hex");
  return `${kind}-${digest}`;
}

export function createStorageVnextUploadRequestHash(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}
