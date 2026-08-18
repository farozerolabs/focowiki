const RESPONSE_RESERVE_TOKENS = 8_192;
const PROMPT_OVERHEAD_TOKENS = 2_000;

export type ModelSourceViewInput = {
  title: string;
  body: string;
  candidateContext: string;
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
    estimateTokenCount(input.candidateContext) +
    RESPONSE_RESERVE_TOKENS +
    PROMPT_OVERHEAD_TOKENS;

  if (fullPromptTokens <= input.contextWindowTokens) {
    return {
      body: ["Markdown body:", fullBody].join("\n"),
      truncated: false
    };
  }

  const availableTokens = Math.max(
    input.contextWindowTokens -
      RESPONSE_RESERVE_TOKENS -
      PROMPT_OVERHEAD_TOKENS -
      estimateTokenCount(input.title) -
      estimateTokenCount(input.candidateContext),
    1
  );
  const headings = extractMarkdownHeadings(fullBody);
  const headingBlock = [
    "Heading outline:",
    ...(headings.length > 0 ? headings.map((heading) => `- ${heading}`) : ["- None"])
  ].join("\n");
  const excerptTokens = Math.max(
    availableTokens - estimateTokenCount(headingBlock) - 100,
    1
  );
  const bodyTokens = Math.max(estimateTokenCount(fullBody), 1);
  const excerptChars = Math.max(
    1,
    Math.min(fullBody.length, Math.floor(fullBody.length * excerptTokens / bodyTokens))
  );
  const excerpts = representativeExcerpts(fullBody, excerptChars);

  return {
    body: [
      "Markdown source view:",
      "truncated: true",
      "",
      headingBlock,
      "",
      "Beginning excerpt:",
      excerpts.beginning,
      "",
      "Middle excerpt 1:",
      excerpts.middleOne,
      "",
      "Middle excerpt 2:",
      excerpts.middleTwo,
      "",
      "Ending excerpt:",
      excerpts.ending
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
    .map((heading) => heading.slice(0, 160))
    .slice(0, 32);
}

function representativeExcerpts(body: string, totalCharacters: number): {
  beginning: string;
  middleOne: string;
  middleTwo: string;
  ending: string;
} {
  const allocations: [number, number, number, number] = [
    0.3, 0.2, 0.2, 0.3
  ].map((share) => Math.max(1, Math.floor(totalCharacters * share))) as [
    number, number, number, number
  ];
  const window = (center: number, length: number) => {
    const start = Math.max(0, Math.min(
      body.length - length,
      Math.floor(center - length / 2)
    ));
    return body.slice(start, start + length).trim();
  };
  return {
    beginning: body.slice(0, allocations[0]).trim(),
    middleOne: window(body.length / 3, allocations[1]),
    middleTwo: window(body.length * 2 / 3, allocations[2]),
    ending: body.slice(Math.max(body.length - allocations[3], 0)).trim()
  };
}
