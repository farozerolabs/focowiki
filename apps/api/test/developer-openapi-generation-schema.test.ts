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
});
