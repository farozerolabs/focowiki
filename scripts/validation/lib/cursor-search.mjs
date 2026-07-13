export async function findInCursorPages({ loadPage, matches, maxPages = 100 }) {
  let cursor = null;

  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const page = await loadPage(cursor);
    const match = (page?.items ?? []).find(matches);

    if (match) {
      return match;
    }

    cursor = page?.nextCursor ?? null;

    if (!cursor) {
      return null;
    }
  }

  return null;
}
