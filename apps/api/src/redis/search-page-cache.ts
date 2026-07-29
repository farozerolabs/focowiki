import { createHash } from "node:crypto";
import type {
  SearchRankCursor,
  SearchRequestIdentity
} from "../developer-openapi/search-pagination.js";
import { createSearchPageCacheScope } from "../developer-openapi/search-pagination.js";
import type { RedisCoordinator } from "./coordination.js";

type SearchPage = {
  items: unknown[];
};

export function createSearchPageCacheId(input: {
  cursor: SearchRankCursor | null;
  limit: number;
}): string {
  const signature = createHash("sha256")
    .update(JSON.stringify({
      cursor: input.cursor,
      limit: input.limit
    }))
    .digest("hex");
  return `page:${signature}`;
}

export async function loadSearchPage<TPage extends SearchPage>(input: {
  redis: RedisCoordinator | null;
  identity: SearchRequestIdentity;
  cursor: SearchRankCursor | null;
  limit: number;
  ttlSeconds: number;
  load: () => Promise<TPage>;
  isSuccessful: (page: TPage) => boolean;
  revalidate: (page: TPage) => Promise<boolean>;
}): Promise<TPage> {
  const scope = createSearchPageCacheScope(input.identity);
  const pageId = createSearchPageCacheId({
    cursor: input.cursor,
    limit: input.limit
  });
  const cached = await readCached<TPage>(input.redis, scope, pageId);
  if (cached && await input.revalidate(cached)) {
    return cached;
  }

  const page = await input.load();
  if (
    input.redis
    && page.items.length <= input.limit
    && input.isSuccessful(page)
    && await input.revalidate(page)
  ) {
    await writeCached(input.redis, scope, pageId, page, input.ttlSeconds);
  }
  return page;
}

async function readCached<T>(
  redis: RedisCoordinator | null,
  scope: string,
  pageId: string
): Promise<T | null> {
  if (!redis) return null;
  try {
    return await redis.getPageCache<T>(scope, pageId);
  } catch {
    return null;
  }
}

async function writeCached<T>(
  redis: RedisCoordinator,
  scope: string,
  pageId: string,
  value: T,
  ttlSeconds: number
): Promise<void> {
  try {
    await redis.setPageCache(scope, pageId, value, ttlSeconds);
  } catch {
    // Search remains available through the authoritative active read path.
  }
}
