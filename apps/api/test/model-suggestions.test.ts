import { describe, expect, it } from "vitest";
import type { ModelSuggestionRequest, OpenAIResponsesClient } from "@focowiki/okf";
import { readModelSuggestions } from "../src/admin/model-suggestions.js";

const receiveTimeouts = {
  maxMs: 5_000,
  idleMs: 5_000
};

function modelAssistance(client: OpenAIResponsesClient) {
  return {
    client,
    modelName: "gpt-test",
    contextWindowTokens: 200_000,
    receiveTimeouts,
    suggestionConcurrency: 2
  };
}

describe("readModelSuggestions", () => {
  it("limits concurrent model suggestion requests with runtime configuration", async () => {
    let active = 0;
    let maxActive = 0;
    const client: OpenAIResponsesClient = {
      responses: {
        create: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 1));
          active -= 1;
          return {
            status: "completed",
            output_text: JSON.stringify({
              description: "Suggested",
              title: "",
              type: "",
              tags: [],
              related_links: [],
              keywords: []
            })
          };
        }
      }
    };

    await readModelSuggestions({
      sources: Array.from({ length: 5 }, (_value, index) => ({
        id: `source-${index}`,
        fileName: `source-${index}.md`,
        title: `Source ${index}`,
        body: `# Source ${index}`
      })),
      modelAssistance: modelAssistance(client)
    });

    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("passes bounded domain-neutral candidate paths per source", async () => {
    const requests: ModelSuggestionRequest[] = [];
    const client: OpenAIResponsesClient = {
      responses: {
        create: async (request) => {
          if (request.text.format.name !== "focowiki_model_suggestions") {
            throw new Error("Unexpected model request format");
          }
          requests.push(request as ModelSuggestionRequest);
          return {
            status: "completed",
            output_text: JSON.stringify({
              description: "Suggested",
              title: "",
              type: "",
              tags: [],
              related_links: [],
              keywords: []
            })
          };
        }
      }
    };

    await readModelSuggestions({
      sources: Array.from({ length: 40 }, (_value, index) => ({
        id: `source-${index}`,
        fileName: `topic-${index}.md`,
        title: index === 0 ? "Alpha guide" : `Alpha reference ${index}`,
        type: "page",
        tags: ["alpha"],
        body: `# Topic ${index}`
      })),
      modelAssistance: modelAssistance(client)
    });

    const firstCandidateLines = requests[0]?.input
      .split("\n")
      .filter((line) => line.startsWith("- /pages/")) ?? [];

    expect(firstCandidateLines.length).toBeGreaterThan(0);
    expect(firstCandidateLines.length).toBeLessThanOrEqual(32);
    expect(firstCandidateLines).not.toContain("- /pages/topic-0.md");
  });

  it("does not reuse prompt state across calls", async () => {
    const requests: ModelSuggestionRequest[] = [];
    const client: OpenAIResponsesClient = {
      responses: {
        create: async (request) => {
          if (request.text.format.name !== "focowiki_model_suggestions") {
            throw new Error("Unexpected model request format");
          }
          requests.push(request as ModelSuggestionRequest);
          return {
            status: "completed",
            output_text: JSON.stringify({
              description: "Suggested",
              title: "",
              type: "",
              tags: [],
              related_links: [],
              keywords: []
            })
          };
        }
      }
    };

    await readModelSuggestions({
      sources: [{ id: "one", fileName: "one.md", title: "One", body: "# One" }],
      modelAssistance: modelAssistance(client)
    });
    await readModelSuggestions({
      sources: [{ id: "two", fileName: "two.md", title: "Two", body: "# Two" }],
      modelAssistance: modelAssistance(client)
    });

    expect(requests[1]?.input).toContain("Two");
    expect(requests[1]?.input).not.toContain("One");
  });
});
