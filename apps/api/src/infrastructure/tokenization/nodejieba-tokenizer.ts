import { createHash } from "node:crypto";
import { accessSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { LexicalTokenizer } from "../../application/ports/lexical-tokenizer.js";

export const NODEJIEBA_PACKAGE_VERSION = "3.5.8";
const TOKENIZER_CONTRACT_PREFIX = "lexical-tokenizer-v1";
const TOKEN_FILTER_VERSION = "nfkc-search-cut-latin-v1";

type NodeJiebaModule = {
  DEFAULT_DICT: string;
  DEFAULT_HMM_DICT: string;
  DEFAULT_USER_DICT: string;
  DEFAULT_IDF_DICT: string;
  DEFAULT_STOP_WORD_DICT: string;
  load: (input: {
    dict: string;
    hmmDict: string;
    userDict: string;
    idfDict: string;
    stopWordDict: string;
  }) => void;
  cutForSearch: (value: string, strict?: boolean) => string[];
};

type PackageMetadata = {
  version?: string;
};

export type NodeJiebaRuntimeEvidence = {
  packageVersion: string;
  contractVersion: string;
  dictionaryChecksums: Record<string, string>;
};

let singleton: LexicalTokenizer | null = null;
let runtimeEvidence: NodeJiebaRuntimeEvidence | null = null;

export function createNodeJiebaTokenizer(): LexicalTokenizer {
  if (singleton) return singleton;
  try {
    return initializeNodeJiebaTokenizer();
  } catch (error) {
    throw new Error("Native lexical tokenizer is unavailable or incompatible", {
      cause: error
    });
  }
}

export function assertNodeJiebaRuntimeAvailable(): void {
  try {
    const require = createRequire(import.meta.url);
    const packagePath = require.resolve("nodejieba/package.json");
    const packageRoot = dirname(packagePath);
    const packageMetadata = require(packagePath) as PackageMetadata;
    if (packageMetadata.version !== NODEJIEBA_PACKAGE_VERSION) {
      throw new Error("Native tokenizer package version is incompatible");
    }
    const requiredFiles = [
      "build/Release/nodejieba.node",
      "submodules/cppjieba/dict/hmm_model.utf8",
      "submodules/cppjieba/dict/idf.utf8",
      "submodules/cppjieba/dict/jieba.dict.utf8",
      "submodules/cppjieba/dict/stop_words.utf8",
      "submodules/cppjieba/dict/user.dict.utf8"
    ];
    for (const relativePath of requiredFiles) {
      accessSync(resolve(packageRoot, relativePath));
    }
    const binding = require(resolve(
      packageRoot,
      "build/Release/nodejieba.node"
    )) as { load?: unknown; cutForSearch?: unknown };
    if (typeof binding.load !== "function" || typeof binding.cutForSearch !== "function") {
      throw new Error("Native tokenizer binding contract is incompatible");
    }
  } catch (error) {
    throw new Error("Native lexical tokenizer runtime is unavailable or incompatible", {
      cause: error
    });
  }
}

function initializeNodeJiebaTokenizer(): LexicalTokenizer {
  const require = createRequire(import.meta.url);
  const nodejieba = require("nodejieba") as NodeJiebaModule;
  const packageMetadata = require("nodejieba/package.json") as PackageMetadata;
  if (packageMetadata.version !== NODEJIEBA_PACKAGE_VERSION) {
    throw new Error("Native tokenizer package version is incompatible");
  }
  const dictionaries = {
    dict: nodejieba.DEFAULT_DICT,
    hmm: nodejieba.DEFAULT_HMM_DICT,
    user: nodejieba.DEFAULT_USER_DICT,
    idf: nodejieba.DEFAULT_IDF_DICT,
    stopWords: nodejieba.DEFAULT_STOP_WORD_DICT
  };
  const dictionaryChecksums = Object.fromEntries(
    Object.entries(dictionaries).map(([name, path]) => [
      name,
      createHash("sha256").update(readFileSync(path)).digest("hex")
    ])
  );
  const contractVersion = `${TOKENIZER_CONTRACT_PREFIX}-${createHash("sha256")
    .update(JSON.stringify({
      packageVersion: NODEJIEBA_PACKAGE_VERSION,
      normalization: "NFKC",
      mode: "cutForSearch",
      tokenFilterVersion: TOKEN_FILTER_VERSION,
      dictionaryChecksums
    }))
    .digest("hex")}`;
  nodejieba.load({
    dict: dictionaries.dict,
    hmmDict: dictionaries.hmm,
    userDict: dictionaries.user,
    idfDict: dictionaries.idf,
    stopWordDict: dictionaries.stopWords
  });

  const tokenize = (value: string, limit: number): string[] => {
    assertTokenLimit(limit);
    const normalized = value.normalize("NFKC").toLocaleLowerCase("en-US");
    const nativeTerms = nodejieba.cutForSearch(normalized);
    const genericTerms = normalized.match(/[a-z0-9][a-z0-9_.-]*/gu) ?? [];
    return normalizeTerms([...nativeTerms, ...genericTerms], limit);
  };
  singleton = {
    contractVersion,
    tokenizeDocument: tokenize,
    tokenizeQuery: tokenize
  };
  runtimeEvidence = {
    packageVersion: NODEJIEBA_PACKAGE_VERSION,
    contractVersion,
    dictionaryChecksums
  };
  return singleton;
}

export function getNodeJiebaRuntimeEvidence(): NodeJiebaRuntimeEvidence {
  createNodeJiebaTokenizer();
  return { ...runtimeEvidence!, dictionaryChecksums: { ...runtimeEvidence!.dictionaryChecksums } };
}

function normalizeTerms(values: string[], limit: number): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const term = value.normalize("NFKC").toLocaleLowerCase("en-US").trim();
    if (!isUsefulToken(term) || seen.has(term)) continue;
    seen.add(term);
    output.push(term);
    if (output.length >= limit) break;
  }
  return output;
}

function isUsefulToken(value: string): boolean {
  if (!/[\p{L}\p{N}]/u.test(value)) return false;
  if (/^\p{N}+$/u.test(value)) return true;
  if (/^\p{Script=Han}$/u.test(value)) return false;
  if (/^[a-z]$/u.test(value)) return false;
  return true;
}

function assertTokenLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 2_000) {
    throw new Error("Tokenizer term limit is invalid");
  }
}
