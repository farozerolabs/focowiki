import { describe, expect, it } from "vitest";
import {
  MODEL_SUGGESTION_SCHEMA,
  buildModelSuggestionRequest,
  requestModelSuggestions,
  validateModelSuggestions
} from "../src/model.js";

function collectObjectSchemas(schema: unknown): Array<Record<string, unknown>> {
  if (!schema || typeof schema !== "object") {
    return [];
  }

  const current = schema as Record<string, unknown>;
  const nested = Object.values(current).flatMap(collectObjectSchemas);

  return current.type === "object" ? [current, ...nested] : nested;
}

describe("OpenAI Structured Outputs model suggestions", () => {
  it("builds a Responses API request with strict JSON Schema text format", () => {
    const request = buildModelSuggestionRequest({
      modelName: "gpt-5.2",
      title: "Getting started",
      body: "# Getting started\n\nWelcome.",
      candidatePaths: ["/pages/intro.md"]
    });

    expect(request.model).toBe("gpt-5.2");
    expect(request.text?.format).toMatchObject({
      type: "json_schema",
      name: "focowiki_model_suggestions",
      strict: true
    });
    expect(request.text?.format).not.toMatchObject({ type: "json_object" });
    expect((request.text?.format as { schema: unknown }).schema).toBe(
      MODEL_SUGGESTION_SCHEMA
    );
  });

  it("defines a schema with only suggestion fields and no additional properties", () => {
    const schema = MODEL_SUGGESTION_SCHEMA as {
      properties: Record<string, unknown>;
    };

    expect(Object.keys(schema.properties).sort()).toEqual([
      "description",
      "headings",
      "keywords",
      "related_links"
    ]);
    expect(JSON.stringify(schema)).not.toMatch(/resource|timestamp|official|identifier/i);
    expect(
      collectObjectSchemas(schema).every((objectSchema) => objectSchema.additionalProperties === false)
    ).toBe(true);
  });

  it("validates suggestions locally and rejects fact metadata", () => {
    expect(
      validateModelSuggestions({
        description: "Short summary",
        headings: ["Overview"],
        related_links: [{ path: "/pages/intro.md", title: "Intro" }],
        keywords: ["overview"]
      })
    ).toEqual({
      description: "Short summary",
      headings: ["Overview"],
      related_links: [{ path: "/pages/intro.md", title: "Intro" }],
      keywords: ["overview"]
    });

    expect(() =>
      validateModelSuggestions({
        description: "Short summary",
        headings: [],
        related_links: [],
        keywords: [],
        resource: "https://example.com/source"
      })
    ).toThrow(/resource/);
  });

  it("returns safe warnings for refusal, incomplete response, invalid output, and provider errors", async () => {
    const commonInput = {
      modelName: "gpt-5.2",
      title: "Getting started",
      body: "# Getting started",
      candidatePaths: []
    };

    await expect(
      requestModelSuggestions({
        ...commonInput,
        client: {
          responses: {
            create: async () => ({
              status: "completed",
              output_text: "",
              output: [
                {
                  type: "message",
                  content: [{ type: "refusal", refusal: "cannot comply" }]
                }
              ]
            })
          }
        }
      })
    ).resolves.toEqual({
      suggestions: null,
      warnings: ["Model refused to provide suggestions"]
    });

    await expect(
      requestModelSuggestions({
        ...commonInput,
        client: {
          responses: {
            create: async () => ({
              status: "incomplete",
              incomplete_details: { reason: "max_output_tokens" },
              output_text: "{}",
              output: []
            })
          }
        }
      })
    ).resolves.toEqual({
      suggestions: null,
      warnings: ["Model response was incomplete: max_output_tokens"]
    });

    await expect(
      requestModelSuggestions({
        ...commonInput,
        client: {
          responses: {
            create: async () => ({
              status: "completed",
              output_text: JSON.stringify({
                description: "OK",
                headings: [],
                related_links: [],
                keywords: [],
                timestamp: "2026-06-14T00:00:00.000Z"
              }),
              output: []
            })
          }
        }
      })
    ).resolves.toEqual({
      suggestions: null,
      warnings: ["Model suggestions failed local schema validation"]
    });

    const providerResult = await requestModelSuggestions({
      ...commonInput,
      client: {
        responses: {
          create: async () => {
            throw new Error("Authorization: Bearer provider-secret MODEL_API_KEY=model-secret");
          }
        }
      }
    });

    expect(providerResult.suggestions).toBeNull();
    expect(providerResult.warnings[0]).toContain("Model provider error");
    expect(providerResult.warnings[0]).not.toContain("provider-secret");
    expect(providerResult.warnings[0]).not.toContain("model-secret");
  });
});
