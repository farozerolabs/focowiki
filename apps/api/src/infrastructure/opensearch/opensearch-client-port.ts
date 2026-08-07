export type OpenSearchClientResponse = { body: unknown };

export type OpenSearchRequestOptions = {
  maxRetries?: number;
  requestTimeout?: number;
};

export type OpenSearchClientPort = {
  info(): Promise<OpenSearchClientResponse>;
  bulk(
    input: Record<string, unknown>,
    options?: OpenSearchRequestOptions
  ): Promise<OpenSearchClientResponse>;
  search(
    input: Record<string, unknown>,
    options?: { requestTimeout?: number }
  ): Promise<OpenSearchClientResponse>;
  count(input: Record<string, unknown>): Promise<OpenSearchClientResponse>;
  get(input: Record<string, unknown>): Promise<OpenSearchClientResponse>;
  deleteByQuery(input: Record<string, unknown>): Promise<OpenSearchClientResponse>;
  indices: {
    exists(input: Record<string, unknown>): Promise<OpenSearchClientResponse>;
    create(input: Record<string, unknown>): Promise<OpenSearchClientResponse>;
    get(input: Record<string, unknown>): Promise<OpenSearchClientResponse>;
    getMapping(input: Record<string, unknown>): Promise<OpenSearchClientResponse>;
    putMapping(input: Record<string, unknown>): Promise<OpenSearchClientResponse>;
    getSettings(input: Record<string, unknown>): Promise<OpenSearchClientResponse>;
    putSettings(input: Record<string, unknown>): Promise<OpenSearchClientResponse>;
    delete(input: Record<string, unknown>): Promise<OpenSearchClientResponse>;
    refresh(input: Record<string, unknown>): Promise<OpenSearchClientResponse>;
  };
  close(): Promise<void>;
};
