import fs from "node:fs/promises";
import path from "node:path";
import { createDeveloperOpenApiDocument } from "../../apps/api/src/developer-openapi/openapi-document.js";

const contractPath = path.join(
  process.cwd(),
  "docs",
  "public",
  "openapi",
  "focowiki-openapi.json"
);
const releaseVersion = process.env.FOCOWIKI_RELEASE_VERSION;

delete process.env.FOCOWIKI_RELEASE_VERSION;
const expected = `${JSON.stringify(createDeveloperOpenApiDocument(), null, 2)}\n`;
if (releaseVersion === undefined) {
  delete process.env.FOCOWIKI_RELEASE_VERSION;
} else {
  process.env.FOCOWIKI_RELEASE_VERSION = releaseVersion;
}

const actual = await fs.readFile(contractPath, "utf8");
if (actual !== expected) {
  throw new Error(
    "The checked-in documentation contract is stale. Run `pnpm docs:generate-api` and commit the generated snapshot."
  );
}

console.log("Developer OpenAPI documentation snapshot is current.");
