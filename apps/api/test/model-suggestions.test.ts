import { describe, expect, it } from "vitest";
import type { ModelSuggestionRequest, OpenAIResponsesClient } from "@focowiki/okf";
import {
  readModelSuggestions,
  type ModelAssistanceOptions
} from "../src/admin/model-suggestions.js";
import { createBoundedTaskRunner } from "../src/runtime/task-runner.js";

const receiveTimeouts = {
  maxMs: 5_000,
  idleMs: 5_000
};

function modelAssistance(
  client: OpenAIResponsesClient,
  options: Partial<ModelAssistanceOptions> = {}
) {
  return {
    client,
    apiMode: "responses" as const,
    modelName: "gpt-test",
    contextWindowTokens: 200_000,
    receiveTimeouts,
    suggestionConcurrency: 2,
    transientRetryDelayMs: 1,
    ...options
  };
}

function readRequestInputText(request: ModelSuggestionRequest | undefined): string {
  if (!request) {
    return "";
  }

  return request.input
    .flatMap((item) =>
      item.content.map((part) => (part.type === "input_text" ? part.text : ""))
    )
    .join("\n");
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

  it("limits concurrent model requests across separate calls with a shared runner", async () => {
    let active = 0;
    let maxActive = 0;
    const client: OpenAIResponsesClient = {
      responses: {
        create: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
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
    const requestRunner = createBoundedTaskRunner(1);

    await Promise.all(
      ["one", "two"].map((id) =>
        readModelSuggestions({
          sources: [{ id, fileName: `${id}.md`, title: id, body: `# ${id}` }],
          modelAssistance: modelAssistance(client, { requestRunner })
        })
      )
    );

    expect(maxActive).toBe(1);
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

    const firstCandidateLines = readRequestInputText(requests[0])
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

    expect(readRequestInputText(requests[1])).toContain("Two");
    expect(readRequestInputText(requests[1])).not.toContain("One");
  });
});
