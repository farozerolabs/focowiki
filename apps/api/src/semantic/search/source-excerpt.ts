const MAXIMUM_SOURCE_EXCERPT_CHARACTERS = 1_200;
const MAXIMUM_SOURCE_EXCERPT_BYTES = 4_096;

export function createBoundedSourceExcerpt(value: string): string {
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized) return "";
  const characters = [...normalized].slice(0, MAXIMUM_SOURCE_EXCERPT_CHARACTERS);
  let lower = 0;
  let upper = characters.length;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (Buffer.byteLength(characters.slice(0, middle).join(""), "utf8")
      <= MAXIMUM_SOURCE_EXCERPT_BYTES) {
      lower = middle;
    } else {
      upper = middle - 1;
    }
  }
  return characters.slice(0, lower).join("");
}
