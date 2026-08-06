import { createHash } from "node:crypto";

const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/u;
const PREFIX_SEGMENT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;

export type StorageVnextImmutableObjectFormat =
  | "source-markdown-v1"
  | "okf-generated-markdown-v1"
  | "okf-generated-json-v1";

export type StorageVnextImmutableObjectDescriptor = {
  objectId: string;
  storageKey: string;
  checksum: string;
  byteCount: number;
  contentType: string;
  objectFormat: StorageVnextImmutableObjectFormat;
};

const FORMATS: Record<StorageVnextImmutableObjectFormat, {
  family: "source" | "generated";
  contentType: string;
  extension: "md" | "json";
}> = {
  "source-markdown-v1": {
    family: "source",
    contentType: "text/markdown; charset=utf-8",
    extension: "md"
  },
  "okf-generated-markdown-v1": {
    family: "generated",
    contentType: "text/markdown; charset=utf-8",
    extension: "md"
  },
  "okf-generated-json-v1": {
    family: "generated",
    contentType: "application/json; charset=utf-8",
    extension: "json"
  }
};

export class StorageVnextContentAddressError extends Error {
  public readonly code = "invalid_input";

  public constructor() {
    super("Storage vNext content-address input is invalid");
    this.name = "StorageVnextContentAddressError";
  }
}

export function describeStorageVnextImmutableObject(input: {
  prefix: string;
  bytes: Uint8Array;
  objectFormat: StorageVnextImmutableObjectFormat;
}): StorageVnextImmutableObjectDescriptor {
  const prefix = requirePrefix(input.prefix);
  if (!(input.bytes instanceof Uint8Array)) throw new StorageVnextContentAddressError();
  const format = FORMATS[input.objectFormat];
  if (!format) throw new StorageVnextContentAddressError();
  const checksum = createHash("sha256").update(input.bytes).digest("hex");
  const objectId = format.family === "source"
    ? `source-sha256:${checksum}`
    : `generated-sha256:${input.objectFormat}:${checksum}`;
  const formatPath = format.family === "source" ? "" : `${input.objectFormat}/`;
  return {
    objectId,
    storageKey: `${prefix}/${format.family}-objects/${formatPath}sha256/${
      checksum.slice(0, 2)
    }/${checksum}.${format.extension}`,
    checksum,
    byteCount: input.bytes.byteLength,
    contentType: format.contentType,
    objectFormat: input.objectFormat
  };
}

export function assertStorageVnextImmutableObjectDescriptor(
  descriptor: StorageVnextImmutableObjectDescriptor
): void {
  if (
    !descriptor.objectId
    || !descriptor.storageKey
    || !CHECKSUM_PATTERN.test(descriptor.checksum)
    || !Number.isSafeInteger(descriptor.byteCount)
    || descriptor.byteCount < 0
    || !FORMATS[descriptor.objectFormat]
    || descriptor.contentType !== FORMATS[descriptor.objectFormat].contentType
  ) {
    throw new StorageVnextContentAddressError();
  }
}

function requirePrefix(value: string): string {
  const prefix = value.trim().replace(/^\/+|\/+$/gu, "");
  const segments = prefix.split("/");
  if (
    !prefix
    || prefix !== value
    || segments.some((segment) =>
      !PREFIX_SEGMENT_PATTERN.test(segment) || segment === "." || segment === "..")
  ) {
    throw new StorageVnextContentAddressError();
  }
  return prefix;
}
