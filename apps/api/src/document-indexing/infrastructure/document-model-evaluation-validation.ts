import { createHash } from "node:crypto";

export function documentModelContractDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function validateModelEvaluationWarnings(values: unknown): string[] {
  if (!Array.isArray(values) || values.length > 1_000
    || values.some((value) => typeof value !== "string"
      || !value || value.length > 256)) {
    throw Object.assign(new Error("Document model warnings are invalid"), {
      code: "model_warnings_invalid"
    });
  }
  return [...values];
}

export function modelEvaluationError(
  code: string
): Error & { code: string } {
  return Object.assign(
    new Error(`Document model evaluation error: ${code}`),
    { code }
  );
}
