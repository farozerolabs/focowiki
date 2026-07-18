import type { SourceFileRecord } from "../db/admin-repositories.js";
import type { StorageAdapter } from "../storage/s3.js";

export async function readSourceFileContent(input: {
  storage: StorageAdapter;
  source: SourceFileRecord;
}): Promise<string> {
  const content = await input.storage.getObjectText(input.source.objectKey);

  if (content === null) {
    throw new Error("Source object was not found");
  }

  return content;
}
