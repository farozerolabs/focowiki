import type { SourceFileRecord } from "@/lib/admin-api";

export function displaySourceFileActions(
  file: Pick<SourceFileRecord, "actions">,
  retrying: boolean
): SourceFileRecord["actions"] {
  return retrying ? [] : file.actions;
}
