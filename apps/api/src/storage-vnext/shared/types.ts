export type StorageVnextKnowledgeBaseId = string;
export type StorageVnextPublicId = string;
export type StorageVnextOpaqueCursor = string;
export type StorageVnextTimestamp = string;
export type StorageVnextChecksum = string;
export type StorageVnextByteCount = number;
export type StorageVnextRevision = number;

export type StorageVnextPage<T> = {
  items: readonly T[];
  nextCursor: StorageVnextOpaqueCursor | null;
};

export type StorageVnextIdempotency = {
  key: string;
  requestHash: string;
};

export type StorageVnextRevisionCheck = {
  expectedRevision: StorageVnextRevision;
};

export type StorageVnextPublicValue =
  | boolean
  | number
  | string
  | null
  | readonly StorageVnextPublicValue[]
  | StorageVnextPublicDocument;

export type StorageVnextPublicDocument = {
  readonly [key: string]: StorageVnextPublicValue | undefined;
};

export type StorageVnextBoundedMetadata = Readonly<
  Record<string, boolean | number | string | null>
>;

export type StorageVnextStructuredMetadata = Readonly<
  Record<string, StorageVnextPublicValue>
>;
