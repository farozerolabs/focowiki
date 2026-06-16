import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/errors.js";

describe("redactSecrets", () => {
  it("redacts named secret assignments", () => {
    expect(
      redactSecrets(
        "ADMIN_PASSWORD=admin-secret ADMIN_SESSION_SECRET: session-secret S3_SECRET_ACCESS_KEY=s3-secret MODEL_API_KEY: model-secret rawKey=fwok_secret OPENAPI_KEY=fwok_other"
      )
    ).toBe(
      "ADMIN_PASSWORD=<redacted> ADMIN_SESSION_SECRET: <redacted> S3_SECRET_ACCESS_KEY=<redacted> MODEL_API_KEY: <redacted> rawKey=<redacted> OPENAPI_KEY=<redacted>"
    );
  });

  it("redacts authorization bearer values", () => {
    expect(redactSecrets("provider failed with Authorization: Bearer sk-secret")).toBe(
      "provider failed with Authorization: Bearer <redacted>"
    );
  });
});
