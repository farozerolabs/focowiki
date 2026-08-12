import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(
  "scripts/validation/comprehensive-release-compose.override.yml",
  "utf8"
);

test("isolates the comprehensive stack from the developer environment and bind mounts", () => {
  for (const service of ["api", "source-worker", "publication-worker", "maintenance-worker", "migrate"]) {
    const section = source.match(new RegExp(`\\n  ${service}:([\\s\\S]*?)(?=\\n  [a-z]|\\nvolumes:)`, "u"))?.[1] ?? "";
    assert.match(section, /env_file:\s*!override/u, service);
    assert.match(section, /\.env\.dev\.example/u, service);
  }
  assert.doesNotMatch(source, /\.\/data|\.\/logs|\.\/runtime-secrets/u);
  for (const volume of ["postgres", "redis", "minio", "meilisearch", "opensearch", "runtime-secrets"]) {
    assert.match(source, new RegExp(`comprehensive-${volume}`, "u"), volume);
  }
});

test("enables bounded PostgreSQL statement evidence only in the validation stack", () => {
  const postgres = source.match(
    /\n  postgres:([\s\S]*?)(?=\n  [a-z]|\nvolumes:)/u
  )?.[1] ?? "";

  assert.match(postgres, /shared_preload_libraries=pg_stat_statements/u);
  assert.match(postgres, /pg_stat_statements\.track=all/u);
  assert.match(postgres, /compute_query_id=on/u);
});
