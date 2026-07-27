import { validationError } from "./errors.js";

const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

export function readIdempotencyKey(value: string | undefined): string {
  const key = value?.trim() ?? "";
  if (!key || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw validationError(
      `Idempotency-Key must contain between 1 and ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
      { field: "Idempotency-Key" }
    );
  }
  return key;
}
