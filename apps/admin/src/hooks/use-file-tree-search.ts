import { useCallback, useEffect, useRef, useState } from "react";
import {
  searchKnowledgeBaseFileTree,
  type GeneratedTreeSearchResult
} from "@/lib/admin-api";

export type FileTreeSearchState = {
  query: string;
  setQuery: (query: string) => void;
  results: GeneratedTreeSearchResult[];
  nextCursor: string | null;
  isLoading: boolean;
  errorMessageKey: string | null;
  isSearchActive: boolean;
  clear: () => void;
  loadMore: () => Promise<void>;
};

const SEARCH_DEBOUNCE_MS = 300;
const MIN_SEARCH_QUERY_LENGTH = 2;

export function useFileTreeSearch(knowledgeBaseId: string): FileTreeSearchState {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GeneratedTreeSearchResult[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessageKey, setErrorMessageKey] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const normalizedQuery = query.trim();
  const isSearchActive = normalizedQuery.length > 0;

  useEffect(() => {
    setQuery("");
    setResults([]);
    setNextCursor(null);
    setIsLoading(false);
    setErrorMessageKey(null);
  }, [knowledgeBaseId]);

  const runSearch = useCallback(
    async (input: { cursor: string | null; append: boolean }) => {
      const requestId = ++requestIdRef.current;

      setIsLoading(true);
      setErrorMessageKey(null);

      const page = await searchKnowledgeBaseFileTree({
        knowledgeBaseId,
        query: normalizedQuery,
        cursor: input.cursor
      }).catch(() => null);

      if (requestId !== requestIdRef.current) {
        return;
      }

      if (!page) {
        setResults((current) => (input.append ? current : []));
        setNextCursor(null);
        setIsLoading(false);
        setErrorMessageKey("detail.fileTreeSearchFailed");
        return;
      }

      setResults((current) => (input.append ? [...current, ...page.items] : page.items));
      setNextCursor(page.nextCursor);
      setIsLoading(false);
    },
    [knowledgeBaseId, normalizedQuery]
  );

  useEffect(() => {
    const requestId = ++requestIdRef.current;

    if (!normalizedQuery) {
      setResults([]);
      setNextCursor(null);
      setIsLoading(false);
      setErrorMessageKey(null);
      return;
    }

    if (normalizedQuery.length < MIN_SEARCH_QUERY_LENGTH) {
      setResults([]);
      setNextCursor(null);
      setIsLoading(false);
      setErrorMessageKey("detail.fileTreeSearchTooShort");
      return;
    }

    setIsLoading(true);
    setErrorMessageKey(null);

    const timeoutId = window.setTimeout(() => {
      if (requestId !== requestIdRef.current) {
        return;
      }
      void runSearch({ cursor: null, append: false });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [normalizedQuery, runSearch]);

  const clear = useCallback(() => {
    setQuery("");
  }, []);

  const loadMore = useCallback(async () => {
    if (!nextCursor || isLoading || normalizedQuery.length < MIN_SEARCH_QUERY_LENGTH) {
      return;
    }

    await runSearch({ cursor: nextCursor, append: true });
  }, [isLoading, nextCursor, normalizedQuery.length, runSearch]);

  return {
    query,
    setQuery,
    results,
    nextCursor,
    isLoading,
    errorMessageKey,
    isSearchActive,
    clear,
    loadMore
  };
}
