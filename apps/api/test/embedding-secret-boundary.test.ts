import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/errors.js";

const root = resolve(import.meta.dirname, "..");

describe("embedding credential boundaries", () => {
  it("keeps credentials out of domain, application ports, and durable snapshots", () => {
    for (const path of [
      "src/semantic/domain/contracts.ts",
      "src/semantic/application/ports.ts",
      "src/semantic/embedding/contract-identity.ts"
    ]) {
      const source = readFileSync(resolve(root, path), "utf8");
      expect(source, path).not.toMatch(/encryptedApiKey|Bearer |decryptRuntimeSecret/iu);
    }
  });

  it("keeps provider payloads out of stable errors and logger redaction", () => {
    const secret = "embedding-private-value";
    expect(redactSecrets(`EMBEDDING_API_KEY=${secret} Authorization: Bearer ${secret}`))
      .not.toContain(secret);
  });

  it("uses a public presenter that structurally removes encrypted key material", () => {
    const service = readFileSync(resolve(
      root,
      "src/semantic/embedding/service.ts"
    ), "utf8");
    expect(service).toMatch(
      /const \{ encryptedApiKey: _encryptedApiKey, \.\.\.safe \} = configuration/u
    );
    expect(service).not.toMatch(/metadata:\s*\{[^}]*encryptedApiKey/su);
  });
});
