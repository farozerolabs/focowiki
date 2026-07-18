export type ImmutableObjectRecord = {
  checksumSha256: string;
  formatVersion: number;
  objectKey: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  verifiedAt: string;
};

export type ImmutableObjectRepository = {
  find: (input: {
    checksumSha256: string;
    formatVersion: number;
  }) => Promise<ImmutableObjectRecord | null>;
  register: (input: {
    checksumSha256: string;
    formatVersion: number;
    objectKey: string;
    contentType: string;
    sizeBytes: number;
    verifiedAt: string;
  }) => Promise<ImmutableObjectRecord>;
};
