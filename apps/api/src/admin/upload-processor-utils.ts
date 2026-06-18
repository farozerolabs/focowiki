import { createHash, randomUUID } from "node:crypto";
import type { SourceFileRecord } from "../db/admin-repositories.js";

export type UploadFile = {
  name: string;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

export type LoadedUploadFile = {
  sourceFileId?: string;
  fileName: string;
  bytes: Uint8Array;
  content: string;
  existingSource?: SourceFileRecord;
};

export async function readBoundedUploadFiles(files: UploadFile[]): Promise<LoadedUploadFile[]> {
  return Promise.all(
    files.map(async (file) => {
      const bytes = new Uint8Array(await file.arrayBuffer());

      return {
        fileName: file.name,
        bytes,
        content: new TextDecoder().decode(bytes)
      };
    })
  );
}

export function createSourceFileId(): string {
  return `source-file-${randomUUID()}`;
}

export function createReleaseId(): string {
  return `release-${randomUUID()}`;
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
