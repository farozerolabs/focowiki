import type {
  StorageVnextImmutableObjectDescriptor,
  StorageVnextImmutableObjectFormat
} from "../ownership/content-address.js";
import type { StorageVnextOwnershipReadPort } from "../ownership/ports.js";
import type {
  StorageVnextImmutableBodyStore
} from "../ownership/s3-immutable-body-store.js";

export function createStorageVnextPublicationObjectValidator(input: {
  registrations: Pick<StorageVnextOwnershipReadPort, "getRegistration">;
  bodyStore: Pick<StorageVnextImmutableBodyStore, "verify" | "readVerified">;
}) {
  return {
    async verify(request: {
      objectId: string;
      checksum: string;
      byteCount: number;
    }): Promise<boolean> {
      const descriptor = await requireDescriptor(input.registrations, request);
      await input.bodyStore.verify({ descriptor });
      return true;
    },
    async readText(request: {
      objectId: string;
      checksum: string;
      byteCount: number;
      maximumBytes: number;
    }): Promise<string> {
      const descriptor = await requireDescriptor(input.registrations, request);
      if (
        descriptor.objectFormat !== "okf-generated-markdown-v1"
        || descriptor.contentType !== "text/markdown; charset=utf-8"
      ) throw new Error("Storage vNext publication object is not generated Markdown");
      const bytes = await input.bodyStore.readVerified({
        descriptor,
        maximumBytes: request.maximumBytes
      });
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error("Storage vNext publication Markdown is not valid UTF-8");
      }
    }
  };
}

async function requireDescriptor(
  registrations: Pick<StorageVnextOwnershipReadPort, "getRegistration">,
  request: { objectId: string; checksum: string; byteCount: number }
): Promise<StorageVnextImmutableObjectDescriptor> {
  const registration = await registrations.getRegistration(request.objectId);
  if (
    !registration
    || registration.state !== "verified"
    || registration.checksum !== request.checksum
    || registration.byteCount !== request.byteCount
    || !isGeneratedFormat(registration.format)
  ) throw new Error("Storage vNext publication object registration is invalid");
  return {
    objectId: registration.objectId,
    storageKey: registration.storageKey,
    checksum: registration.checksum,
    byteCount: registration.byteCount,
    contentType: registration.contentType,
    objectFormat: registration.format
  };
}

function isGeneratedFormat(value: string): value is StorageVnextImmutableObjectFormat {
  return value === "okf-generated-markdown-v1"
    || value === "okf-generated-json-v1";
}
