import { createHash } from "node:crypto";

export function documentDirectoryEntryId(
  kind: "file" | "directory",
  targetPath: string
): string {
  const segments = targetPath.split("/");
  if (!targetPath || targetPath.startsWith("/") || targetPath.includes("\\")
    || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Document directory entry target path is invalid");
  }
  return `${kind}-${createHash("sha256").update(targetPath).digest("hex")}`;
}
