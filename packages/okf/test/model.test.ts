import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GRAPH_RELATIONSHIP_CONFIRMATION_SCHEMA,
  MODEL_SUGGESTION_SCHEMA,
  buildGraphRelationshipConfirmationRequest,
  buildModelSuggestionRequest,
  receiveWithProgressTimeout,
  requestGraphRelationshipConfirmations,
  requestModelSuggestions,
  validateGraphRelationshipConfirmations,
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

  it("builds a bounded graph relationship confirmation request", () => {
    const request = buildGraphRelationshipConfirmationRequest({
      modelName: "gpt-5.2",
      currentFile: {
        fileId: "source-a",
        path: "pages/a.md",
        title: "A",
        tags: ["guide"]
      },
      body: "# A\n\nSee B.",
      candidates: [
        {
          fromFileId: "source-a",
          toFileId: "source-b",
          relationType: "title_mention",
          weight: 0.7,
          reason: "The source body mentions the related file title.",
          source: "deterministic"
        }
      ],
      candidateFiles: [
        {
          fileId: "source-b",
          path: "pages/b.md",
          title: "B",
          tags: ["guide"]
        }
      ],
      contextWindowTokens: 200_000
    });

    expect(request.model).toBe("gpt-5.2");
    expect(request.instructions).toContain("only evaluate the provided candidate");
    expect(request.input).toContain("\"targetFileId\": \"source-b\"");
    expect(request.input).not.toContain("source-c");
    expect(request.text.format).toMatchObject({
      type: "json_schema",
      name: "focowiki_graph_relationship_confirmations",
      strict: true,
      schema: GRAPH_RELATIONSHIP_CONFIRMATION_SCHEMA
    });
  });

  it("validates graph relationship confirmations with strict local schema", () => {
    expect(
      validateGraphRelationshipConfirmations({
        relationships: [
          {
            targetFileId: "source-b",
            accepted: true,
            relationType: "title_mention",
            weight: 0.8,
            reason: "The current file refers to the related title."
          }
        ]
      })
    ).toEqual([
      {
        targetFileId: "source-b",
        accepted: true,
        relationType: "title_mention",
        weight: 0.8,
        reason: "The current file refers to the related title."
      }
    ]);

    expect(() =>
      validateGraphRelationshipConfirmations({
        relationships: [
          {
            targetFileId: "source-b",
            accepted: true,
            relationType: "title_mention",
            weight: 1.2,
            reason: "Unsafe weight"
          }
        ]
      })
    ).toThrow(/weight/);

    expect(() =>
      validateGraphRelationshipConfirmations({
        relationships: [
          {
            targetFileId: "source-b",
            accepted: true,
            relationType: "title_mention",
            weight: 0.8,
            reason: "OK",
            inventedPath: "pages/c.md"
          }
        ]
      })
    ).toThrow(/inventedPath/);
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

  it("backs off before retrying transient provider failures", async () => {
    let attempts = 0;
    const result = await requestModelSuggestions({
      modelName: "gpt-5.2",
      title: "Retry",
      body: "# Retry",
      candidatePaths: [],
      contextWindowTokens: 200_000,
      transientRetryDelayMs: 1,
      receiveTimeouts: {
        maxMs: 5_000,
        idleMs: 5_000
      },
      client: {
        responses: {
          create: async () => {
            attempts += 1;

            if (attempts === 1) {
              throw new Error("429 model credentials are cooling down");
            }

            return {
              status: "completed",
              output_text: JSON.stringify({
                description: "Recovered after provider retry",
                title: "",
                type: "",
                tags: ["retry"],
                related_links: [],
                keywords: ["retry"]
              }),
              output: []
            };
          }
        }
      }
    });

    expect(attempts).toBe(2);
    expect(result.suggestions?.description).toBe("Recovered after provider retry");
    expect(result.warnings).toEqual([]);
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

  it("accepts fenced or surrounding text around valid model JSON output", async () => {
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
              output_text: [
                "```json",
                JSON.stringify({
                  description: "From fenced JSON",
                  title: "",
                  type: "",
                  tags: [],
                  related_links: [],
                  keywords: ["fenced"]
                }),
                "```"
              ].join("\n"),
              output: []
            })
          }
        }
      })
    ).resolves.toMatchObject({
      suggestions: {
        description: "From fenced JSON",
        keywords: ["fenced"]
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
              output_text: [
                "Here is the JSON object:",
                JSON.stringify({
                  description: "From embedded JSON",
                  title: "",
                  type: "",
                  tags: [],
                  related_links: [],
                  keywords: ["embedded"]
                }),
                "Done."
              ].join("\n"),
              output: []
            })
          }
        }
      })
    ).resolves.toMatchObject({
      suggestions: {
        description: "From embedded JSON",
        keywords: ["embedded"]
      },
      warnings: []
    });
  });

  it("accepts fenced graph relationship confirmation JSON output", async () => {
    await expect(
      requestGraphRelationshipConfirmations({
        modelName: "gpt-5.2",
        currentFile: {
          fileId: "source-a",
          path: "pages/a.md",
          title: "A"
        },
        body: "# A",
        candidates: [
          {
            fromFileId: "source-a",
            toFileId: "source-b",
            relationType: "shared_topic",
            weight: 0.7,
            reason: "Both files share a stable topic.",
            source: "deterministic"
          }
        ],
        candidateFiles: [
          {
            fileId: "source-b",
            path: "pages/b.md",
            title: "B"
          }
        ],
        contextWindowTokens: 200_000,
        receiveTimeouts: {
          maxMs: 5_000,
          idleMs: 5_000
        },
        client: {
          responses: {
            create: async () => ({
              status: "completed",
              output_text: [
                "```json",
                JSON.stringify({
                  relationships: [
                    {
                      targetFileId: "source-b",
                      accepted: true,
                      relationType: "shared_topic",
                      weight: 0.8,
                      reason: "The files share a stable topic."
                    }
                  ]
                }),
                "```"
              ].join("\n")
            })
          }
        }
      })
    ).resolves.toMatchObject({
      confirmations: [
        {
          targetFileId: "source-b",
          accepted: true,
          relationType: "shared_topic",
          weight: 0.8
        }
      ],
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

  it("repairs graph relationship confirmation output once", async () => {
    const requests: Array<{ input: string }> = [];
    const result = await requestGraphRelationshipConfirmations({
      modelName: "gpt-5.2",
      currentFile: {
        fileId: "source-a",
        path: "pages/a.md",
        title: "A"
      },
      body: "# A",
      candidates: [
        {
          fromFileId: "source-a",
          toFileId: "source-b",
          relationType: "shared_tag",
          weight: 0.6,
          reason: "Both files share tags.",
          source: "deterministic"
        }
      ],
      candidateFiles: [
        {
          fileId: "source-b",
          path: "pages/b.md",
          title: "B"
        }
      ],
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
                  relationships: [
                    {
                      targetFileId: "source-b",
                      accepted: true,
                      relationType: "shared_tag",
                      weight: "high",
                      reason: "Invalid"
                    }
                  ]
                })
              };
            }

            return {
              status: "completed",
              output_text: JSON.stringify({
                relationships: [
                  {
                    targetFileId: "source-b",
                    accepted: true,
                    relationType: "shared_tag",
                    weight: 0.85,
                    reason: "The files share a stable topic tag."
                  }
                ]
              })
            };
          }
        }
      }
    });

    expect(result).toEqual({
      confirmations: [
        {
          targetFileId: "source-b",
          accepted: true,
          relationType: "shared_tag",
          weight: 0.85,
          reason: "The files share a stable topic tag."
        }
      ],
      warnings: []
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.input).toContain("Previous attempt error:");
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
