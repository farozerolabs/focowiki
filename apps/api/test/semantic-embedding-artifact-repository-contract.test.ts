import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("semantic embedding artifact repository SQL contract", () => {
  it("orders distinct superseded artifact identities by the selected collation alias", async () => {
    const source = await readFile(new URL(
      "../src/semantic/infrastructure/postgres-embedding-artifact-repository.ts",
      import.meta.url
    ), "utf8");

    expect(source).toMatch(
      /SELECT DISTINCT reference\.artifact_public_id COLLATE "C"\s+AS artifact_public_id/u
    );
    expect(source).toContain("ORDER BY artifact_public_id");
    expect(source).not.toContain(
      'ORDER BY reference.artifact_public_id COLLATE "C"'
    );
  });

  it("returns the newest artifact reference for each source owner", async () => {
    const source = await readFile(new URL(
      "../src/semantic/infrastructure/postgres-embedding-artifact-repository.ts",
      import.meta.url
    ), "utf8");

    expect(source).toContain(
      "SELECT DISTINCT ON (artifact.input_kind, artifact.owner_public_id)"
    );
    expect(source).toMatch(
      /ORDER BY artifact\.input_kind,\s+artifact\.owner_public_id,\s+artifact\.created_at DESC/u
    );
  });
});
