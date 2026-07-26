import { describe, expect, it } from "vitest";
import {
  readIdempotencyKey
} from "../src/developer-openapi/idempotency-key.js";

describe("Developer OpenAPI idempotency keys", () => {
  it("accepts bounded stable keys", () => {
    expect(readIdempotencyKey(" operation-123 ")).toBe("operation-123");
    expect(readIdempotencyKey("x".repeat(255))).toHaveLength(255);
  });

  it("rejects missing and oversized keys", () => {
    expect(() => readIdempotencyKey(undefined)).toThrowError(
      expect.objectContaining({ code: "VALIDATION_ERROR" })
    );
    expect(() => readIdempotencyKey("x".repeat(256))).toThrowError(
      expect.objectContaining({ code: "VALIDATION_ERROR" })
    );
  });
});
