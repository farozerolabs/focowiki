import {
  requestModelSuggestions,
  type ModelSuggestions,
  type OpenAIResponsesClient
} from "@focowiki/okf";

export type ModelAssistanceOptions = {
  client: OpenAIResponsesClient;
  modelName: string;
};

export type ModelSuggestionSource = {
  id: string;
  fileName: string;
  title: string;
  body: string;
};

const MODEL_SUGGESTION_CONCURRENCY = 8;

export async function readModelSuggestions(input: {
  sources: ModelSuggestionSource[];
  modelAssistance: ModelAssistanceOptions | null;
}): Promise<{
  suggestionsBySourceId: Map<string, ModelSuggestions>;
  warnings: string[];
}> {
  const suggestionsBySourceId = new Map<string, ModelSuggestions>();
  const warnings: string[] = [];

  if (!input.modelAssistance) {
    return {
      suggestionsBySourceId,
      warnings
    };
  }

  const modelAssistance = input.modelAssistance;
  const candidatePaths = input.sources.map((source) =>
    toMarkdownHref(sourceFileNameToPagePath(source.fileName))
  );

  await mapWithConcurrency(input.sources, MODEL_SUGGESTION_CONCURRENCY, async (source) => {
    const result = await requestModelSuggestions({
      client: modelAssistance.client,
      modelName: modelAssistance.modelName,
      title: source.title,
      body: source.body,
      candidatePaths
    });

    if (result.suggestions) {
      suggestionsBySourceId.set(source.id, result.suggestions);
    }

    warnings.push(...result.warnings);
  });

  return {
    suggestionsBySourceId,
    warnings
  };
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<void>
): Promise<void> {
  const workerCount = Math.min(Math.max(concurrency, 1), items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      await mapper(item as T);
    }
  });

  await Promise.all(workers);
}

function sourceFileNameToPagePath(fileName: string): string {
  const normalized = fileName.trim();

  return `pages/${normalized}`;
}

function toMarkdownHref(path: string): string {
  return `/${path.split("/").map(encodeURIComponent).join("/")}`;
}
