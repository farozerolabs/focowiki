import { readFileSync, statSync } from "node:fs";

const MAX_SECRET_FILE_BYTES = 4_096;

export function readConfiguredSecret(input: {
  env: Record<string, string | undefined>;
  valueField: string;
  fileField: string;
  issues: string[];
}): string {
  const directValue = input.env[input.valueField]?.trim();
  if (directValue) return directValue;

  const filePath = input.env[input.fileField]?.trim();
  if (!filePath) return "";

  try {
    const stats = statSync(filePath);
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_SECRET_FILE_BYTES) {
      input.issues.push(`${input.fileField} must reference a non-empty secret file`);
      return "";
    }

    const value = readFileSync(filePath, "utf8").trim();
    if (!value) {
      input.issues.push(`${input.fileField} must reference a non-empty secret file`);
      return "";
    }
    return value;
  } catch {
    input.issues.push(`${input.fileField} must reference a readable secret file`);
    return "";
  }
}
