import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portPath = resolve(
  import.meta.dirname,
  "../src/application/ports/search-provider-runtime.ts"
);
const source = existsSync(portPath) ? readFileSync(portPath, "utf8") : "";

describe("provider-neutral search ports Red contract", () => {
  it("defines immutable provider identity and focused capability ports", () => {
    expect(source).toContain(
      'export type SearchProviderKind = "meilisearch" | "opensearch"'
    );
    for (const name of [
      "SearchProviderAdminPort",
      "SearchProviderWritePort",
      "SearchProviderQueryPort",
      "SearchProviderValidationPort",
      "SearchProviderOperationPort",
      "SearchProviderMaintenancePort",
      "SearchProviderRuntime"
    ]) {
      expect(source, name).toContain(`export interface ${name}`);
    }
  });

  it("accepts structured product filters without raw engine syntax", () => {
    expect(source).toContain("export type SearchFilterExpression =");
    expect(source).toContain('kind: "equals"');
    expect(source).toContain('kind: "and"');
    expect(source).toContain('kind: "boolean"');
    expect(source).not.toMatch(/filter\??:\s*string/u);
  });

  it("normalizes product queries, hits, snippets, and stable ordering", () => {
    expect(source).toContain("export type SearchProviderQueryRequest =");
    expect(source).toContain("export type SearchProviderQueryResult =");
    expect(source).toContain("export type SearchProviderHit =");
    expect(source).toContain("snippets:");
    expect(source).toContain("continuation:");
  });

  it("uses completed or pending receipts with opaque string references", () => {
    expect(source).toContain("export type SearchProviderOperationReceipt =");
    expect(source).toContain('state: "completed"');
    expect(source).toContain('state: "pending"');
    expect(source).toContain("operationRef: string");
    expect(source).not.toContain("taskUid: number");
  });

  it("supports bounded stable scans and exact owned-index deletion", () => {
    expect(source).toContain("export type SearchProviderDocumentScanPage =");
    expect(source).toContain("continuation: string | null");
    expect(source).toMatch(/scanDocuments\(input:\s*\{/u);
    expect(source).toMatch(/limit:\s*number/u);
    expect(source).toMatch(/deleteIndex\(input:\s*\{\s*indexUid:\s*string/u);
    expect(source).not.toMatch(/listIndexes\??\(/u);
  });

  it("keeps optional maintenance capabilities and safe errors isolated", () => {
    expect(source).toContain("maintenance?: SearchProviderMaintenancePort");
    expect(source).toContain("export type SearchProviderErrorCode =");
    expect(source).toContain("export class SearchProviderError extends Error");
    expect(source).toContain("retryable: boolean");
  });
});
