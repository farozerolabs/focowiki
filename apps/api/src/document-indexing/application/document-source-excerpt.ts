const MAXIMUM_EXCERPT_CHARACTERS = 1_200;
const MAXIMUM_EXCERPT_BYTES = 4_096;

export function documentSourceExcerpt(value: string): string {
  const parts: string[] = [];
  let characters = 0;
  let bytes = 0;

  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (
      characters >= MAXIMUM_EXCERPT_CHARACTERS
      || bytes + characterBytes > MAXIMUM_EXCERPT_BYTES
    ) {
      break;
    }
    parts.push(character);
    characters += 1;
    bytes += characterBytes;
  }

  return parts.join("");
}
