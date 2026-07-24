export type LexicalTokenizer = {
  contractVersion: string;
  tokenizeDocument: (value: string, limit: number) => string[];
  tokenizeQuery: (value: string, limit: number) => string[];
};
