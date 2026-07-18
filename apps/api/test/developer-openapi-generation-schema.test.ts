import { describe, expect, it } from "vitest";
import { createDeveloperOpenApiDocument } from "../src/developer-openapi/openapi-document.js";

describe("Developer OpenAPI generation schema", () => {
  it("exposes final generated-file contracts without legacy bundle components", () => {
    const document = createDeveloperOpenApiDocument();
    const schemas = document.components.schemas;
    const serialized = JSON.stringify(document);

    expect(schemas).toHaveProperty("GeneratedTreeEntry");
    expect(schemas).toHaveProperty("GeneratedFile");
    expect(schemas).not.toHaveProperty("BundleTreeEntry");
    expect(schemas).not.toHaveProperty("BundleFile");
    expect(serialized).not.toContain("BundleTreeEntry");
    expect(serialized).not.toContain("BundleFile");
    expect(serialized).not.toContain("Bundle file identifier");
  });

  it("documents the same default tree parent used by the runtime", () => {
    const document = createDeveloperOpenApiDocument();
    const operation = document.paths["/openapi/v2/knowledge-bases/{knowledgeBaseId}/tree"]?.get as {
      parameters?: Array<{
        name?: string;
        in?: string;
        schema?: { default?: unknown };
      }>;
    } | undefined;
    const parentPath = operation?.parameters?.find((parameter) =>
      parameter.name === "parentPath"
    );

    expect(parentPath).toMatchObject({
      in: "query",
      schema: { default: "pages" }
    });
  });

  it("keeps checksums in upload requests and out of response schemas", () => {
    const schemas = createDeveloperOpenApiDocument().components.schemas;
    expect(schemas.UploadManifestEntryRequest?.properties).toHaveProperty("checksumSha256");
    for (const responseSchema of ["UploadSessionEntry", "SourceResourceFile", "GeneratedFile"]) {
      expect(schemas[responseSchema]?.properties).not.toHaveProperty("checksumSha256");
      expect(schemas[responseSchema]?.required).not.toContain("checksumSha256");
    }
  });
});
