import assert from "node:assert/strict";
import test from "node:test";

import {
  createPostgresQueryShape,
  extractPostgresTaggedTemplates
} from "../lib/comprehensive-persistence-inventory.mjs";

test("normalizes source template interpolations and observed parameters identically", () => {
  const source = createPostgresQueryShape(`
    SELECT public_id
    FROM focowiki.knowledge_bases
    WHERE public_id = \${publicId}
      AND revision = 2
      AND deleted_at IS NULL
  `);
  const observed = createPostgresQueryShape(`
    SELECT public_id
    FROM focowiki.knowledge_bases
    WHERE public_id = $1
      AND revision = $2
      AND deleted_at IS NULL
  `);

  assert.equal(source.normalized, observed.normalized);
  assert.equal(source.fingerprint, observed.fingerprint);
  assert.equal(source.parameterCount, 2);
});

test("keeps stable identifiers while excluding interpolated SQL fragments from anchors", () => {
  const shape = createPostgresQueryShape(`
    SELECT source.public_id
    FROM focowiki.source_files AS source
    \${optionalJoin}
    WHERE source.knowledge_base_id = \${knowledgeBaseId}
    ORDER BY source.public_id COLLATE "C"
    LIMIT \${limit}
  `);

  assert.match(shape.normalized, /focowiki\.source_files/u);
  assert.doesNotMatch(shape.anchorNormalized, /optionaljoin|knowledgebaseid/u);
  assert.match(shape.anchorNormalized, /source\.public_id/u);
  assert.ok(shape.anchorTokenHashes.length > 0);
  assert.ok(shape.anchorTokenHashes.every((hash) => /^[a-f0-9]{64}$/u.test(hash)));
  assert.equal(shape.parameterCount, 3);
});

test("extracts a complete SQL template when an interpolation contains nested templates", () => {
  const source = `
    const query = sql\`
      SELECT source.public_id
      FROM focowiki.source_files AS source
      \${enabled ? sql\`WHERE source.status = \${status}\` : sql\`\`}
      ORDER BY source.public_id COLLATE "C"
    \`;
  `;

  const templates = extractPostgresTaggedTemplates(source);

  assert.equal(templates.length, 1);
  assert.match(templates[0].body, /SELECT source\.public_id/u);
  assert.match(templates[0].body, /ORDER BY source\.public_id/u);
  assert.match(templates[0].body, /enabled \? sql/u);
});
