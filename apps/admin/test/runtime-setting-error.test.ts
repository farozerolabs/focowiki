import { describe, expect, it } from "vitest";
import { runtimeSettingFailureMessageKey } from "../src/lib/runtime-setting-error";

describe("runtime setting error presentation", () => {
  it.each([
    ["databaseCapacity", "settings.validation.databaseCapacity"],
    ["searchCapacity", "settings.validation.searchCapacity"],
    ["objectStoreCapacity", "settings.validation.objectStoreCapacity"],
    ["memoryCapacity", "settings.validation.memoryCapacity"],
    ["cpuCapacity", "settings.validation.cpuCapacity"],
    ["resourceCapacity", "settings.validation.resourceCapacity"]
  ])("maps the %s issue to actionable copy", (field, expected) => {
    expect(runtimeSettingFailureMessageKey({
      messageKey: "errors.runtimeSettingsValidationFailed",
      issues: [{ field }]
    })).toBe(expected);
  });

  it("keeps the backend message key for unknown issues", () => {
    expect(runtimeSettingFailureMessageKey({
      messageKey: "errors.runtimeSettingsValidationFailed",
      issues: [{ field: "futureConstraint" }]
    })).toBe("errors.runtimeSettingsValidationFailed");
  });
});
