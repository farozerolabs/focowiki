import {
  extractSubstantiveMarkdownBody,
  normalizeMarkdownBody,
  parseHeading
} from "./body-normalization.js";

export const BODY_SEGMENT_MAX_CHARS = 2_048;
export const BODY_SEGMENT_OVERLAP_CHARS = 128;
export const BODY_HEADING_MAX_CHARS = 512;
export const BODY_SEGMENTATION_VERSION = "body-segmentation-v1";

export type MarkdownBodySegment = {
  ordinal: number;
  heading: string | null;
  text: string;
};

type PendingBlock = {
  heading: string | null;
  text: string;
};

export function segmentMarkdownBody(value: string): MarkdownBodySegment[] {
  const body = extractSubstantiveMarkdownBody(value);
  if (!body) return [];
  const blocks = collectBlocks(body);
  const segments: MarkdownBodySegment[] = [];

  for (const block of blocks) {
    const pieces = splitOversizedBlock(block.text);
    for (const piece of pieces) {
      const previous = segments.at(-1);
      if (
        previous
        && previous.heading === block.heading
        && previous.text.length + 2 + piece.length <= BODY_SEGMENT_MAX_CHARS
      ) {
        previous.text = `${previous.text}\n\n${piece}`;
        continue;
      }
      segments.push({
        ordinal: segments.length,
        heading: block.heading,
        text: piece
      });
    }
  }

  return segments;
}

function collectBlocks(body: string): PendingBlock[] {
  const blocks: PendingBlock[] = [];
  let heading: string | null = null;
  let paragraph: string[] = [];

  const flush = (): void => {
    const text = normalizeMarkdownBody(paragraph.join("\n"));
    paragraph = [];
    if (text) blocks.push({ heading, text });
  };

  for (const line of body.split("\n")) {
    const parsedHeading = parseHeading(line);
    if (parsedHeading) {
      flush();
      heading = [...parsedHeading.title].slice(0, BODY_HEADING_MAX_CHARS).join("");
      blocks.push({ heading, text: parsedHeading.title });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

function splitOversizedBlock(value: string): string[] {
  const characters = [...value];
  if (characters.length <= BODY_SEGMENT_MAX_CHARS) return [value];
  const output: string[] = [];
  const step = BODY_SEGMENT_MAX_CHARS - BODY_SEGMENT_OVERLAP_CHARS;

  for (let start = 0; start < characters.length; start += step) {
    const end = Math.min(characters.length, start + BODY_SEGMENT_MAX_CHARS);
    output.push(characters.slice(start, end).join(""));
    if (end === characters.length) break;
  }
  return output;
}
