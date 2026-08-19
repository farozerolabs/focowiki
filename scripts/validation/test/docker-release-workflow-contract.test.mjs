import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workflow = fs.readFileSync(
  ".github/workflows/docker-build.yml",
  "utf8"
);

test("keeps live source contract validation independent from the release version", () => {
  const sourceValidation = workflow.match(
    /      - name: Validate source contracts\n(?<body>(?:        .*\n|\n)+?)(?=      - name:)/u
  )?.groups?.body;

  assert.ok(sourceValidation, "missing source contract validation step");
  assert.match(sourceValidation, /run: pnpm test:validation/u);
  assert.doesNotMatch(sourceValidation, /FOCOWIKI_RELEASE_VERSION/u);
});

test("validates the generated OpenAPI with the resolved release version", () => {
  const releaseValidation = workflow.match(
    /      - name: Validate release OpenAPI\n(?<body>(?:        .*\n|\n)+?)(?=      - name:)/u
  )?.groups?.body;

  assert.ok(releaseValidation, "missing release OpenAPI validation step");
  assert.match(
    releaseValidation,
    /FOCOWIKI_RELEASE_VERSION: \$\{\{ steps\.release\.outputs\.version \}\}/u
  );
  assert.match(releaseValidation, /run: pnpm openapi:validate/u);
});
