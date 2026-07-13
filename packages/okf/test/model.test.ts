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

function readRequestInputText(request: { input: unknown }): string {
  const input = request.input;

  if (!Array.isArray(input)) {
    return "";
  }

  return input
    .flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }

      const content = (item as { content?: unknown }).content;

      if (!Array.isArray(content)) {
        return [];
      }

      return content.map((part) =>
        part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : ""
      );
    })
    .join("\n");
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
    expect(request.instructions).toContain("Markdown file analysis assistant");
    expect(request.instructions).toContain("Example output structure");
    expect(request.instructions).toContain('"related_links":');
    expect(request.instructions).toContain("Do not invent facts");
    expect(request.instructions).toContain("Use the primary natural language of the Markdown content");
    expect(request.instructions).toContain("avoid ASCII double quote characters");
    expect(request.instructions).not.toMatch(/OKF-style|knowledge bundle/i);
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
          relationType: "direct_reference",
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
    expect(request.instructions).toContain("Markdown file relationship reviewer");
    expect(request.instructions).toContain("Return this JSON structure");
    expect(request.instructions).toContain('"relationships":');
    expect(request.instructions).toContain('"targetFileId":"source-file-id-from-candidate"');
    expect(request.instructions).toContain('{"relationships":[]}');
    expect(request.instructions).toContain("Evaluate only the provided candidate relationships");
    expect(request.instructions).toContain("Reject weak relationships");
    expect(request.instructions).toContain("central subject or primary entity in both files");
    expect(request.instructions).toContain("incidental references");
    expect(request.instructions).toContain("candidate relationship type does not match");
    expect(request.instructions).toContain("same uniquely identifiable entity");
    expect(request.instructions).toContain("shared location, publisher, authority, owner, namespace, or collection");
    expect(request.instructions).toContain("Use only these relationType values");
    expect(request.instructions).toContain("same_specific_subject");
    expect(request.instructions).toContain("avoid ASCII double quote characters");
    expect(request.instructions).not.toMatch(/OKF-style|knowledge bundle/i);
    expect(readRequestInputText(request)).toContain("\"targetFileId\": \"source-b\"");
    expect(readRequestInputText(request)).not.toContain("source-c");
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
            relationType: "direct_reference",
            weight: 0.8,
            reason: "The current file refers to the related title."
          }
        ]
      })
    ).toEqual([
      {
        targetFileId: "source-b",
        accepted: true,
        relationType: "direct_reference",
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
            relationType: "direct_reference",
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
            relationType: "direct_reference",
            weight: 0.8,
            reason: "OK",
            inventedPath: "pages/c.md"
          }
        ]
      })
    ).toThrow(/inventedPath/);

    expect(() =>
      validateGraphRelationshipConfirmations({
        relationships: [
          {
            targetFileId: "source-b",
            accepted: true,
            relationType: "same_region",
            weight: 0.8,
            reason: "Broad metadata match"
          }
        ]
      })
    ).toThrow(/relationType/);
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

    expect(readRequestInputText(request)).toContain("Markdown body:");
    expect(readRequestInputText(request)).toContain("Full body content.");
    expect(readRequestInputText(request)).not.toContain("Markdown source view:");
  });

  it("uses a bounded deterministic source view when full Markdown exceeds context", () => {
    const request = buildModelSuggestionRequest({
      modelName: "small-model",
      title: "Small context",
      body: ["# First heading", "A".repeat(2_000), "## Last heading", "B".repeat(2_000)].join("\n\n"),
      candidatePaths: ["/pages/related.md"],
      contextWindowTokens: 1_200
    });

    const inputText = readRequestInputText(request);
    expect(inputText).toContain("Markdown source view:");
    expect(inputText).toContain("First heading");
    expect(inputText).toContain("Last heading");
    expect(inputText).toContain("truncated");
    expect(inputText.length).toBeLessThan(2_500);
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

  it("uses Chat Completions JSON object mode when selected", async () => {
    const requests: unknown[] = [];
    const result = await requestModelSuggestions({
      modelName: "deepseek-chat",
      title: "Chat mode",
      body: "# Chat mode",
      candidatePaths: ["/pages/related.md"],
      contextWindowTokens: 200_000,
      receiveTimeouts: {
        maxMs: 5_000,
        idleMs: 5_000
      },
      client: {
        apiMode: "chat_completions",
        chat: {
          completions: {
            create: async (request) => {
              requests.push(request);
              return {
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        description: "Generated through chat completions",
                        title: "",
                        type: "",
                        tags: ["chat"],
                        related_links: [],
                        keywords: ["chat"]
                      })
                    }
                  }
                ]
              };
            }
          }
        }
      }
    });

    expect(result).toEqual({
      suggestions: {
        description: "Generated through chat completions",
        title: "",
        type: "",
        tags: ["chat"],
        related_links: [],
        keywords: ["chat"]
      },
      warnings: []
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      model: "deepseek-chat",
      response_format: { type: "json_object" },
      stream: false
    });
    expect(JSON.stringify(requests[0])).toContain("Return exactly one JSON object");
    expect(JSON.stringify(requests[0])).not.toContain("json_schema");
  });

  it("returns safe Chat Completions warnings for empty output and provider 404", async () => {
    const commonInput = {
      modelName: "deepseek-chat",
      title: "Chat failure",
      body: "# Chat failure",
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
          apiMode: "chat_completions",
          chat: {
            completions: {
              create: async () => ({ choices: [{ message: { content: "" } }] })
            }
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
        apiMode: "chat_completions",
        chat: {
          completions: {
            create: async () => {
              throw new Error("404 status code Authorization: Bearer provider-secret");
            }
          }
        }
      }
    });

    expect(providerResult.suggestions).toBeNull();
    expect(providerResult.warnings[0]).toContain("Model provider error");
    expect(providerResult.warnings[0]).toContain("404 status code");
    expect(providerResult.warnings[0]).not.toContain("provider-secret");
  });

  it("returns a safe Chat Completions warning for invalid JSON output", async () => {
    await expect(
      requestModelSuggestions({
        modelName: "deepseek-chat",
        title: "Invalid JSON",
        body: "# Invalid JSON",
        candidatePaths: [],
        contextWindowTokens: 200_000,
        receiveTimeouts: {
          maxMs: 5_000,
          idleMs: 5_000
        },
        client: {
          apiMode: "chat_completions",
          chat: {
            completions: {
              create: async () => ({ choices: [{ message: { content: "{invalid" } }] })
            }
          }
        }
      })
    ).resolves.toEqual({
      suggestions: null,
      warnings: [
        "Model suggestions failed local schema validation: response was not valid JSON"
      ]
    });
  });

  it("repairs Chat Completions schema-invalid output once", async () => {
    const requests: unknown[] = [];
    const result = await requestModelSuggestions({
      modelName: "deepseek-chat",
      title: "Chat repair",
      body: "# Chat repair",
      candidatePaths: [],
      contextWindowTokens: 200_000,
      receiveTimeouts: {
        maxMs: 5_000,
        idleMs: 5_000
      },
      client: {
        apiMode: "chat_completions",
        chat: {
          completions: {
            create: async (request) => {
              requests.push(request);

              if (requests.length === 1) {
                return {
                  choices: [
                    {
                      message: {
                        content: JSON.stringify({
                          description: 1,
                          title: "",
                          type: "",
                          tags: [],
                          related_links: [],
                          keywords: []
                        })
                      }
                    }
                  ]
                };
              }

              return {
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        description: "Repaired chat output",
                        title: "",
                        type: "",
                        tags: [],
                        related_links: [],
                        keywords: ["repair"]
                      })
                    }
                  }
                ]
              };
            }
          }
        }
      }
    });

    expect(result.suggestions?.description).toBe("Repaired chat output");
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1])).toContain("Previous attempt error:");
  });

  it("uses Chat Completions for graph relationship confirmation", async () => {
    const result = await requestGraphRelationshipConfirmations({
      modelName: "deepseek-chat",
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
        apiMode: "chat_completions",
        chat: {
          completions: {
            create: async () => ({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      relationships: [
                        {
                          targetFileId: "source-b",
                          accepted: true,
                          relationType: "same_specific_subject",
                          weight: 0.81,
                          reason: "The files share visible topic evidence."
                        }
                      ]
                    })
                  }
                }
              ]
            })
          }
        }
      }
    });

    expect(result).toMatchObject({
      confirmations: [
        {
          targetFileId: "source-b",
          accepted: true,
          relationType: "same_specific_subject",
          weight: 0.81
        }
      ],
      warnings: []
    });
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
    const requests: Array<{ input: unknown }> = [];
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
    const repairInputText = requests[1] ? readRequestInputText(requests[1]) : "";
    expect(repairInputText).toContain("Previous attempt error:");
    expect(repairInputText).toContain("Markdown body:");
    expect(repairInputText).not.toContain("Authorization");
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
                      relationType: "same_specific_subject",
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
          relationType: "same_specific_subject",
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
    const requests: Array<{ input: unknown }> = [];
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
                      relationType: "same_specific_subject",
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
                    relationType: "same_specific_subject",
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
          relationType: "same_specific_subject",
          weight: 0.85,
          reason: "The files share a stable topic tag."
        }
      ],
      warnings: []
    });
    expect(requests).toHaveLength(2);
    expect(requests[1] ? readRequestInputText(requests[1]) : "").toContain(
      "Previous attempt error:"
    );
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
