export const OBJECT_PROTECTION_CLASSES = [
  "active_reference",
  "write_reservation",
  "retained_reference",
  "source",
  "registered",
  "projection_segment"
] as const;

export type ObjectProtectionClass = (typeof OBJECT_PROTECTION_CLASSES)[number];

export type ObjectProtectionReadiness =
  | "pending"
  | "backfilling"
  | "verifying"
  | "ready"
  | "retrying"
  | "failed";

export type ObjectProtectionRecord = {
  objectKey: string;
  checksumSha256: string;
  formatVersion: number;
  protected: boolean;
  dirty: boolean;
  revision: number;
  classes: ObjectProtectionClass[];
  refreshedAt: string | null;
};
