import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { Client } from "@opensearch-project/opensearch";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws-v3";
import { describe, expect, it } from "vitest";

describe("OpenSearch runtime dependencies", () => {
  it("imports the official client and renewable AWS credential helpers", () => {
    expect(Client).toBeTypeOf("function");
    expect(AwsSigv4Signer).toBeTypeOf("function");
    expect(defaultProvider).toBeTypeOf("function");
  });
});
