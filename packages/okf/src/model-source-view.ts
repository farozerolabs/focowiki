const RESPONSE_RESERVE_TOKENS = 1_000;
const PROMPT_OVERHEAD_TOKENS = 500;
const MIN_EXCERPT_CHARS = 400;

export type ModelSourceViewInput = {
  title: string;
  body: string;
  candidatePaths: string[];
  contextWindowTokens: number;
};

export function buildModelSourceView(input: ModelSourceViewInput): {
  body: string;
  truncated: boolean;
} {
  const fullBody = input.body;
  const fullPromptTokens =
    estimateTokenCount(input.title) +
    estimateTokenCount(fullBody) +
    estimateTokenCount(input.candidatePaths.join("\n")) +
    RESPONSE_RESERVE_TOKENS +
    PROMPT_OVERHEAD_TOKENS;

  if (fullPromptTokens <= input.contextWindowTokens) {
    return {
      body: ["Markdown body:", fullBody].join("\n"),
      truncated: false
    };
  }

  const availableTokens = Math.max(
    input.contextWindowTokens - RESPONSE_RESERVE_TOKENS - PROMPT_OVERHEAD_TOKENS,
    1
  );
  const excerptChars = Math.max(Math.floor(availableTokens * 2), MIN_EXCERPT_CHARS);
  const headChars = Math.ceil(excerptChars * 0.6);
  const tailChars = Math.floor(excerptChars * 0.4);
  const headings = extractMarkdownHeadings(fullBody);

  return {
    body: [
      "Markdown source view:",
      "truncated: true",
      "",
      "Heading outline:",
      ...(headings.length > 0 ? headings.map((heading) => `- ${heading}`) : ["- None"]),
      "",
      "Beginning excerpt:",
      fullBody.slice(0, headChars).trim(),
      "",
      "Ending excerpt:",
      fullBody.slice(Math.max(fullBody.length - tailChars, 0)).trim()
    ].join("\n"),
    truncated: true
  };
}

export function estimateTokenCount(value: string): number {
  let cjk = 0;
  let other = 0;

  for (const char of value) {
    if (/[\u3400-\u9FFF\uF900-\uFAFF]/u.test(char)) {
      cjk += 1;
    } else if (!/\s/u.test(char)) {
      other += 1;
    }
  }

  return cjk + Math.ceil(other / 4);
}

function extractMarkdownHeadings(body: string): string[] {
  return body
    .split(/\r?\n/)
    .map((line) => line.match(/^(#{1,6})\s+(.+)$/u)?.[2]?.trim())
    .filter((heading): heading is string => Boolean(heading))
    .slice(0, 32);
}
