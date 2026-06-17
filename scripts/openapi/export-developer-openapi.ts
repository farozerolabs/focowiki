import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { createDeveloperOpenApiDocument } from "../../apps/api/src/developer-openapi/openapi-document.js";

const defaultOutput = "docs/public/openapi/focowiki-openapi.json";

async function main() {
  const outputPath = resolve(process.cwd(), readOutputPath());
  const document = createDeveloperOpenApiDocument();

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  console.log(`Exported Developer OpenAPI contract to ${relative(process.cwd(), outputPath)}`);
}

function readOutputPath(): string {
  const outputIndex = process.argv.indexOf("--output");

  if (outputIndex === -1) {
    return defaultOutput;
  }

  const value = process.argv[outputIndex + 1];

  if (!value) {
    throw new Error("--output requires a file path.");
  }

  return value;
}

await main();
