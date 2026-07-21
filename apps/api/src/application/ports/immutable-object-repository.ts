export type ImmutableObjectRecord = {
  checksumSha256: string;
  formatVersion: number;
  objectKey: string;
  contentType: string;
  sizeBytes: number;
  lifecycleState: "writing" | "active" | "deleting";
  writeToken: string | null;
  writeStartedAt: string | null;
  writeAttemptCount: number;
  createdAt: string;
  verifiedAt: string | null;
};

export type ActiveImmutableObjectRecord = ImmutableObjectRecord & {
  lifecycleState: "active";
  verifiedAt: string;
};

export type ImmutableObjectIdentity = {
  checksumSha256: string;
  formatVersion: number;
};

export type ImmutableObjectExpectedMetadata = ImmutableObjectIdentity & {
  objectKey: string;
  contentType: string;
  sizeBytes: number;
};

export type ImmutableObjectRepository = {
  find: (input: ImmutableObjectIdentity) => Promise<ActiveImmutableObjectRecord | null>;
  findAny: (input: ImmutableObjectIdentity) => Promise<ImmutableObjectRecord | null>;
  reserve: (input: ImmutableObjectExpectedMetadata & {
    writeToken: string;
    writeStartedAt: string;
    staleBefore: string;
  }) => Promise<
    | {
      status: "reserved" | "active" | "pending";
      record: ImmutableObjectRecord;
    }
    | {
      status: "deleting";
      record: null;
    }
  >;
  activate: (input: ImmutableObjectExpectedMetadata & {
    writeToken: string;
    verifiedAt: string;
  }) => Promise<ActiveImmutableObjectRecord>;
  releaseFailedWrite: (input: ImmutableObjectIdentity & {
    writeToken: string;
  }) => Promise<boolean>;
};

export type ImmutableObjectRecoveryRepository = {
  claimStaleWriting: (input: {
    staleBefore: string;
    claimedAt: string;
    recoveryToken: string;
    limit: number;
  }) => Promise<ImmutableObjectExpectedMetadata[]>;
  activateRecovered: (input: ImmutableObjectExpectedMetadata & {
    recoveryToken: string;
    verifiedAt: string;
  }) => Promise<boolean>;
  expireMissing: (input: ImmutableObjectIdentity & {
    recoveryToken: string;
  }) => Promise<boolean>;
  releaseRecoveryFailure: (input: ImmutableObjectIdentity & {
    recoveryToken: string;
  }) => Promise<boolean>;
};
