import { defaultProvider } from "@aws-sdk/credential-provider-node";
import {
  Client,
  type ClientOptions
} from "@opensearch-project/opensearch";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws";
import { readFileSync } from "node:fs";
import { SearchProviderError } from
  "../../application/ports/search-provider-runtime.js";
import type { OpenSearchStartupConfig } from "../../runtime/search-config.js";
import { normalizeOpenSearchError } from "./opensearch-errors.js";

type CredentialProvider = () => Promise<{
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}>;

type OpenSearchClientDependencies = {
  readFile?: (path: string) => Buffer;
  defaultProvider?: () => CredentialProvider;
  awsSigner?: (input: {
    region: string;
    service: "es" | "aoss";
    getCredentials: CredentialProvider;
  }) => Record<string, unknown>;
};

export function createOpenSearchClientOptions(input: {
  config: OpenSearchStartupConfig;
  requestTimeoutMs: number;
  maxAttempts: number;
}, dependencies: OpenSearchClientDependencies = {}): ClientOptions {
  assertClientConfiguration(input);
  const endpoint = new URL(input.config.endpoint);
  const options: ClientOptions = {
    node: endpoint.toString().replace(/\/$/u, ""),
    requestTimeout: input.requestTimeoutMs,
    maxRetries: input.maxAttempts - 1,
    sniffOnStart: false,
    sniffInterval: false,
    sniffOnConnectionFault: false,
    memoryCircuitBreaker: {
      enabled: true,
      maxPercentage: 0.8
    }
  };

  if (input.config.tls.caFile) {
    const readFile = dependencies.readFile ?? ((path: string) => readFileSync(path));
    let ca: Buffer;
    try {
      ca = readFile(input.config.tls.caFile);
    } catch {
      throw requestError();
    }
    if (ca.length === 0) throw requestError();
    options.ssl = { ca, rejectUnauthorized: true };
  }

  if (input.config.auth.mode === "basic") {
    options.auth = {
      username: input.config.auth.username,
      password: input.config.auth.password
    };
  } else if (input.config.auth.mode === "aws_sigv4") {
    const resolveDefaultProvider = dependencies.defaultProvider
      ?? (() => defaultProvider());
    const credentials = resolveDefaultProvider();
    const signer = dependencies.awsSigner ?? ((signerInput) =>
      AwsSigv4Signer(signerInput) as unknown as Record<string, unknown>);
    Object.assign(options, signer({
      region: input.config.auth.region,
      service: input.config.auth.service,
      getCredentials: () => credentials()
    }));
  }

  return options;
}

export function createOpenSearchClient(input: {
  config: OpenSearchStartupConfig;
  requestTimeoutMs: number;
  maxAttempts: number;
}): Client {
  try {
    return new Client(createOpenSearchClientOptions(input));
  } catch (error) {
    if (error instanceof SearchProviderError) throw error;
    throw requestError();
  }
}

export async function probeOpenSearchCompatibility(client: {
  info(): Promise<{ body: unknown }>;
}): Promise<{ available: true; version: string }> {
  let body: unknown;
  try {
    body = (await client.info()).body;
  } catch (error) {
    throw normalizeOpenSearchError(error);
  }
  const record = objectValue(body);
  const version = objectValue(record?.version);
  const distribution = stringValue(version?.distribution);
  const number = stringValue(version?.number);
  const tagline = stringValue(record?.tagline);
  if (
    distribution !== "opensearch"
    || tagline !== "The OpenSearch Project: https://opensearch.org/"
    || !number
    || !isSupportedVersion(number)
  ) {
    throw new SearchProviderError(
      "SEARCH_ENGINE_VERSION_INCOMPATIBLE",
      false
    );
  }
  return { available: true, version: number };
}

export async function assertOpenSearchReadiness(client: {
  info(): Promise<{ body: unknown }>;
  bulk?: unknown;
  search?: unknown;
  count?: unknown;
  get?: unknown;
  deleteByQuery?: unknown;
  indices?: Record<string, unknown>;
}): Promise<{ available: true; version: string }> {
  const requiredRootOperations = [
    client.bulk,
    client.search,
    client.count,
    client.get,
    client.deleteByQuery
  ];
  const indices = client.indices;
  const requiredIndexOperations = [
    "exists",
    "create",
    "get",
    "getMapping",
    "putMapping",
    "getSettings",
    "putSettings",
    "delete",
    "refresh"
  ].map((operation) => indices?.[operation]);
  if (
    requiredRootOperations.some((operation) => typeof operation !== "function")
    || requiredIndexOperations.some((operation) => typeof operation !== "function")
  ) {
    throw new SearchProviderError(
      "SEARCH_ENGINE_VERSION_INCOMPATIBLE",
      false
    );
  }
  return probeOpenSearchCompatibility(client);
}

function assertClientConfiguration(input: {
  config: OpenSearchStartupConfig;
  requestTimeoutMs: number;
  maxAttempts: number;
}): void {
  if (
    input.config.provider !== "opensearch"
    || !Number.isSafeInteger(input.requestTimeoutMs)
    || input.requestTimeoutMs < 100
    || input.requestTimeoutMs > 30_000
    || !Number.isSafeInteger(input.maxAttempts)
    || input.maxAttempts < 1
    || input.maxAttempts > 20
  ) throw requestError();
  let endpoint: URL;
  try {
    endpoint = new URL(input.config.endpoint);
  } catch {
    throw requestError();
  }
  if (
    !["http:", "https:"].includes(endpoint.protocol)
    || endpoint.username
    || endpoint.password
    || (input.config.tls.caFile && endpoint.protocol !== "https:")
  ) throw requestError();
  if (input.config.auth.mode === "basic" && (
    !input.config.auth.username || !input.config.auth.password
  )) throw requestError();
  if (input.config.auth.mode === "aws_sigv4" && (
    endpoint.protocol !== "https:"
    || !input.config.auth.region
    || !["es", "aoss"].includes(input.config.auth.service)
  )) throw requestError();
}

function isSupportedVersion(value: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(value);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major === 3 && minor >= 8 || major === 2 && minor === 19;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function requestError(): SearchProviderError {
  return new SearchProviderError("SEARCH_ENGINE_REQUEST_FAILED", false);
}
