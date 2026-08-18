import type { ApiFailure } from "./admin-api";

const CAPACITY_MESSAGE_KEYS: Record<string, string> = {
  databaseCapacity: "settings.validation.databaseCapacity",
  searchCapacity: "settings.validation.searchCapacity",
  objectStoreCapacity: "settings.validation.objectStoreCapacity",
  memoryCapacity: "settings.validation.memoryCapacity",
  cpuCapacity: "settings.validation.cpuCapacity",
  resourceCapacity: "settings.validation.resourceCapacity"
};

export function runtimeSettingFailureMessageKey(failure: ApiFailure): string {
  for (const issue of failure.issues ?? []) {
    const messageKey = CAPACITY_MESSAGE_KEYS[issue.field];
    if (messageKey) return messageKey;
  }
  return failure.messageKey;
}
