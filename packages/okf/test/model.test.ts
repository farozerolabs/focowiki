import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MODEL_SUGGESTION_SCHEMA,
  buildModelSuggestionRequest,
  receiveWithProgressTimeout,
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
  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds a Responses API request with strict JSON Schema text format", () => {
    const request = buildModelSuggestionRequest({
      modelName: "gpt-5.2",
      title: "Getting started",
      body: "# Getting started\n\nWelcome.",
      candidatePaths: ["/pages/intro.md"],
      contextWindowTokens: 200_000
    });

    expect(request.model).toBe("gpt-5.2");
    expect(request.instructions).toContain("Return raw JSON only");
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
      "keywords",
      "related_links",
      "tags",
      "title",
      "type"
    ]);
    expect(JSON.stringify(schema)).not.toMatch(/headings/);
    expect(JSON.stringify(schema)).not.toMatch(/resource|timestamp|official|identifier/i);
    expect(
      collectObjectSchemas(schema).every((objectSchema) => objectSchema.additionalProperties === false)
    ).toBe(true);
  });

  it("validates suggestions locally and rejects fact metadata", () => {
    expect(
      validateModelSuggestions({
        description: "Short summary",
        title: "",
        type: "",
        tags: [],
        related_links: [{ path: "/pages/intro.md", title: "Intro" }],
        keywords: ["overview"]
      })
    ).toEqual({
      description: "Short summary",
      title: "",
      type: "",
      tags: [],
      related_links: [{ path: "/pages/intro.md", title: "Intro" }],
      keywords: ["overview"]
    });

    expect(() =>
      validateModelSuggestions({
        description: "Short summary",
        title: "",
        type: "",
        tags: [],
        related_links: [],
        keywords: [],
        resource: "https://example.com/source"
      })
    ).toThrow(/resource/);

    expect(() =>
      validateModelSuggestions({
        description: "Short summary",
        title: "",
        type: "",
        tags: [],
        headings: [],
        related_links: [],
        keywords: []
      })
    ).toThrow(/headings/);
  });

  it("uses full Markdown when it fits the configured model context window", () => {
    const request = buildModelSuggestionRequest({
      modelName: "gpt-5.2",
      title: "Long context",
      body: "# Long context\n\nFull body content.",
      candidatePaths: ["/pages/related.md"],
      contextWindowTokens: 200_000
    });

    expect(request.input).toContain("Markdown body:");
    expect(request.input).toContain("Full body content.");
    expect(request.input).not.toContain("Markdown source view:");
  });

  it("uses a bounded deterministic source view when full Markdown exceeds context", () => {
    const request = buildModelSuggestionRequest({
      modelName: "small-model",
      title: "Small context",
      body: ["# First heading", "A".repeat(2_000), "## Last heading", "B".repeat(2_000)].join("\n\n"),
      candidatePaths: ["/pages/related.md"],
      contextWindowTokens: 1_200
    });

    expect(request.input).toContain("Markdown source view:");
    expect(request.input).toContain("First heading");
    expect(request.input).toContain("Last heading");
    expect(request.input).toContain("truncated");
    expect(request.input.length).toBeLessThan(2_500);
  });

  it("returns safe warnings for refusal, incomplete response, invalid output, and provider errors", async () => {
    const commonInput = {
      modelName: "gpt-5.2",
      title: "Getting started",
      body: "# Getting started",
      candidatePaths: [],
      contextWindowTokens: 200_000,
      receiveTimeouts: {
        maxMs: 5_000,
        idleMs: 5_000
      }
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
                title: "",
                type: "",
                tags: [],
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
      warnings: ["Model suggestions failed local schema validation: root: Unrecognized key: \"timestamp\""]
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

  it("repairs one retryable invalid output with the same bounded source view and sanitized error", async () => {
    const requests: Array<{ input: string }> = [];
    const result = await requestModelSuggestions({
      modelName: "gpt-5.2",
      title: "Repair",
      body: "# Repair\n\nContent.",
      candidatePaths: ["/pages/related.md"],
      contextWindowTokens: 200_000,
      receiveTimeouts: {
        maxMs: 5_000,
        idleMs: 5_000
      },
      client: {
        responses: {
          create: async (request) => {
            requests.push(request);

            if (requests.length === 1) {
              return {
                status: "completed",
                output_text: JSON.stringify({
                  description: 42,
                  title: "",
                  type: "",
                  tags: [],
                  related_links: [],
                  keywords: []
                })
              };
            }

            return {
              status: "completed",
              output_text: JSON.stringify({
                description: "Repaired",
                title: "",
                type: "",
                tags: [],
                related_links: [],
                keywords: ["repair"]
              })
            };
          }
        }
      }
    });

    expect(result).toEqual({
      suggestions: {
        description: "Repaired",
        title: "",
        type: "",
        tags: [],
        related_links: [],
        keywords: ["repair"]
      },
      warnings: []
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.input).toContain("Previous attempt error:");
    expect(requests[1]?.input).toContain("Markdown body:");
    expect(requests[1]?.input).not.toContain("Authorization");
  });

  it("reads model output from Responses output content and chat-compatible choices", async () => {
    const commonInput = {
      modelName: "gpt-5.2",
      title: "Compatibility",
      body: "# Compatibility",
      candidatePaths: [],
      contextWindowTokens: 200_000,
      receiveTimeouts: {
        maxMs: 5_000,
        idleMs: 5_000
      }
    };

    await expect(
      requestModelSuggestions({
        ...commonInput,
        client: {
          responses: {
            create: async () => ({
              status: "completed",
              output: [
                {
                  type: "message",
                  content: [
                    {
                      type: "output_text",
                      text: JSON.stringify({
                        description: "From response content",
                        title: "",
                        type: "",
                        tags: [],
                        related_links: [],
                        keywords: ["response"]
                      })
                    }
                  ]
                }
              ]
            })
          }
        }
      })
    ).resolves.toMatchObject({
      suggestions: {
        description: "From response content",
        keywords: ["response"]
      },
      warnings: []
    });

    await expect(
      requestModelSuggestions({
        ...commonInput,
        client: {
          responses: {
            create: async () => ({
              status: "completed",
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      description: "From choices",
                      title: "",
                      type: "",
                      tags: [],
                      related_links: [],
                      keywords: ["choices"]
                    })
                  }
                }
              ]
            })
          }
        }
      })
    ).resolves.toMatchObject({
      suggestions: {
        description: "From choices",
        keywords: ["choices"]
      },
      warnings: []
    });
  });

  it("records one safe warning after two failed attempts", async () => {
    const result = await requestModelSuggestions({
      modelName: "gpt-5.2",
      title: "Failure",
      body: "# Failure",
      candidatePaths: [],
      contextWindowTokens: 200_000,
      receiveTimeouts: {
        maxMs: 5_000,
        idleMs: 5_000
      },
      client: {
        responses: {
          create: async () => ({
            status: "completed",
            output_text: "{"
          })
        }
      }
    });

    expect(result.suggestions).toBeNull();
    expect(result.warnings).toEqual([
      "Model suggestions failed local schema validation: response was not valid JSON"
    ]);
  });

  it("keeps receiving while progress is active before the hard timeout", async () => {
    vi.useFakeTimers();

    const promise = receiveWithProgressTimeout({
      timeouts: {
        maxMs: 100,
        idleMs: 20
      },
      start: async (progress) =>
        new Promise<string>((resolve) => {
          setTimeout(progress, 10);
          setTimeout(progress, 25);
          setTimeout(progress, 40);
          setTimeout(() => resolve("done"), 50);
        })
    });

    await vi.advanceTimersByTimeAsync(55);
    await expect(promise).resolves.toBe("done");
  });

  it("aborts on idle no-progress timeout and hard maximum timeout", async () => {
    vi.useFakeTimers();

    const idlePromise = receiveWithProgressTimeout({
      timeouts: {
        maxMs: 100,
        idleMs: 20
      },
      start: async () =>
        new Promise<string>((resolve) => {
          setTimeout(() => resolve("late"), 50);
        })
    });

    const idleExpectation = expect(idlePromise).rejects.toThrow(/idle/i);
    await vi.advanceTimersByTimeAsync(21);
    await idleExpectation;

    const hardPromise = receiveWithProgressTimeout({
      timeouts: {
        maxMs: 35,
        idleMs: 20
      },
      start: async (progress) =>
        new Promise<string>((resolve) => {
          setTimeout(progress, 10);
          setTimeout(progress, 25);
          setTimeout(() => resolve("late"), 50);
        })
    });

    const hardExpectation = expect(hardPromise).rejects.toThrow(/maximum/i);
    await vi.advanceTimersByTimeAsync(36);
    await hardExpectation;
  });
});
