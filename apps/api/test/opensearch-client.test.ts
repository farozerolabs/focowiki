import { describe, expect, it, vi } from "vitest";
import type { OpenSearchStartupConfig } from "../src/runtime/search-config.js";
import {
  assertOpenSearchReadiness,
  createOpenSearchClientOptions,
  probeOpenSearchCompatibility
} from "../src/infrastructure/opensearch/opensearch-client.js";

describe("OpenSearch client", () => {
  it("creates a bounded plain development client without implicit auth", () => {
    const options = createOpenSearchClientOptions({
      config: openSearchConfig({ auth: { mode: "none" } }),
      requestTimeoutMs: 2_500,
      maxAttempts: 3
    });

    expect(options).toMatchObject({
      node: "http://127.0.0.1:9200",
      requestTimeout: 2_500,
      maxRetries: 2
    });
    expect(options).not.toHaveProperty("auth");
  });

  it("uses HTTPS basic auth and a private CA without embedding credentials", () => {
    const readFile = vi.fn(() => Buffer.from("test-ca"));
    const options = createOpenSearchClientOptions({
      config: openSearchConfig({
        endpoint: "https://search.example.test",
        auth: { mode: "basic", username: "runtime-user", password: "secret-value" },
        tls: { caFile: "/run/secrets/opensearch-ca.pem" }
      }),
      requestTimeoutMs: 5_000,
      maxAttempts: 2
    }, { readFile });

    expect(options.node).toBe("https://search.example.test");
    expect(options.auth).toEqual({
      username: "runtime-user",
      password: "secret-value"
    });
    expect(options.ssl).toMatchObject({
      ca: Buffer.from("test-ca"),
      rejectUnauthorized: true
    });
    expect(readFile).toHaveBeenCalledWith("/run/secrets/opensearch-ca.pem");
    expect(String(options.node)).not.toContain("secret-value");
  });

  it("rejects an unreadable or empty private CA without exposing its path", () => {
    const caPath = "/run/secrets/private-provider-name-ca.pem";
    for (const readFile of [
      vi.fn(() => { throw new Error(`cannot read ${caPath}`); }),
      vi.fn(() => Buffer.alloc(0))
    ]) {
      const error = (() => {
        try {
          createOpenSearchClientOptions({
            config: openSearchConfig({
              endpoint: "https://search.example.test",
              tls: { caFile: caPath }
            }),
            requestTimeoutMs: 5_000,
            maxAttempts: 2
          }, { readFile });
          return null;
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toMatchObject({ code: "SEARCH_ENGINE_REQUEST_FAILED" });
      expect(JSON.stringify(error)).not.toContain(caPath);
    }
  });

  for (const service of ["es", "aoss"] as const) {
    it(`uses renewable AWS credentials for ${service} SigV4`, async () => {
      const credentials = vi.fn()
        .mockResolvedValueOnce({ accessKeyId: "first", secretAccessKey: "secret" })
        .mockResolvedValueOnce({ accessKeyId: "second", secretAccessKey: "secret" });
      const defaultProvider = vi.fn(() => credentials);
      const signerInputs: Record<string, unknown>[] = [];
      const awsSigner = vi.fn((input: Record<string, unknown>) => {
        signerInputs.push(input);
        return { Connection: class {}, Transport: class {} };
      });

      const options = createOpenSearchClientOptions({
        config: openSearchConfig({
          endpoint: "https://search.example.test",
          auth: { mode: "aws_sigv4", region: "us-east-1", service }
        }),
        requestTimeoutMs: 5_000,
        maxAttempts: 2
      }, { defaultProvider, awsSigner });

      expect(options).toHaveProperty("Connection");
      expect(options).toHaveProperty("Transport");
      expect(defaultProvider).toHaveBeenCalledOnce();
      const signerInput = signerInputs[0]!;
      expect(signerInput).toMatchObject({ region: "us-east-1", service });
      const getCredentials = signerInput.getCredentials;
      expect(getCredentials).toBeTypeOf("function");
      await expect((getCredentials as () => Promise<unknown>)())
        .resolves.toMatchObject({ accessKeyId: "first" });
      await expect((getCredentials as () => Promise<unknown>)())
        .resolves.toMatchObject({ accessKeyId: "second" });
    });
  }

  it("rejects invalid TLS and auth inputs with secret-safe errors", () => {
    const password = "must-not-leak";
    for (const config of [
      openSearchConfig({
        endpoint: "http://127.0.0.1:9200",
        tls: { caFile: "/tmp/ca.pem" }
      }),
      openSearchConfig({
        endpoint: `https://runtime-user:${password}@search.example.test`
      }),
      openSearchConfig({
        auth: { mode: "basic", username: "", password }
      })
    ]) {
      const error = (() => {
        try {
          createOpenSearchClientOptions({
            config,
            requestTimeoutMs: 5_000,
            maxAttempts: 2
          });
          return null;
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toMatchObject({ code: "SEARCH_ENGINE_REQUEST_FAILED" });
      expect(JSON.stringify(error)).not.toContain(password);
      expect(String(error)).not.toContain(password);
    }
  });

  it("accepts the OpenSearch 3.8 baseline and maintained 2.19 line", async () => {
    await expect(probeOpenSearchCompatibility(clientInfo("3.8.0")))
      .resolves.toEqual({ available: true, version: "3.8.0" });
    await expect(probeOpenSearchCompatibility(clientInfo("2.19.3")))
      .resolves.toEqual({ available: true, version: "2.19.3" });
  });

  it("rejects old, foreign, and malformed cluster information safely", async () => {
    for (const client of [
      clientInfo("3.7.0"),
      clientInfo("2.18.0"),
      clientInfo("3.8.0", "elasticsearch"),
      { info: vi.fn(async () => ({ body: { version: {} } })) }
    ]) {
      await expect(probeOpenSearchCompatibility(client as never)).rejects.toMatchObject({
        code: "SEARCH_ENGINE_VERSION_INCOMPATIBLE",
        retryable: false
      });
    }
  });

  it("classifies readiness request failures safely", async () => {
    const timeout = new Error("provider response detail");
    timeout.name = "TimeoutError";
    const cases = [
      [responseError(401), "SEARCH_ENGINE_AUTHENTICATION_FAILED", false],
      [responseError(403), "SEARCH_ENGINE_AUTHORIZATION_FAILED", false],
      [responseError(408), "SEARCH_ENGINE_TIMEOUT", true],
      [responseError(429), "SEARCH_ENGINE_OVERLOADED", true],
      [responseError(503), "SEARCH_ENGINE_OVERLOADED", true],
      [timeout, "SEARCH_ENGINE_TIMEOUT", true],
      [new Error("connection failed"), "SEARCH_ENGINE_UNAVAILABLE", true]
    ] as const;

    for (const [providerError, code, retryable] of cases) {
      const client = {
        info: vi.fn(async () => { throw providerError; })
      };
      const error = await probeOpenSearchCompatibility(client)
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({ code, retryable });
      expect(JSON.stringify(error)).not.toContain("provider response detail");
    }
  });

  it("checks every required standard operation before work is claimed", async () => {
    const client = capableClient("3.8.0");
    await expect(assertOpenSearchReadiness(client as never)).resolves.toEqual({
      available: true,
      version: "3.8.0"
    });

    const missingBulk = capableClient("3.8.0");
    delete (missingBulk as { bulk?: unknown }).bulk;
    await expect(assertOpenSearchReadiness(missingBulk as never))
      .rejects.toMatchObject({
        code: "SEARCH_ENGINE_VERSION_INCOMPATIBLE",
        retryable: false
      });
  });
});

function openSearchConfig(
  overrides: Partial<OpenSearchStartupConfig> = {}
): OpenSearchStartupConfig {
  return {
    provider: "opensearch",
    endpoint: "http://127.0.0.1:9200",
    indexPrefix: "focowiki",
    auth: { mode: "none" },
    tls: {},
    ...overrides
  };
}

function clientInfo(version: string, distribution = "opensearch") {
  return {
    info: vi.fn(async () => ({
      body: {
        version: { distribution, number: version },
        tagline: "The OpenSearch Project: https://opensearch.org/"
      }
    }))
  };
}

function capableClient(version: string) {
  return {
    ...clientInfo(version),
    bulk: vi.fn(),
    search: vi.fn(),
    count: vi.fn(),
    get: vi.fn(),
    deleteByQuery: vi.fn(),
    indices: {
      exists: vi.fn(),
      create: vi.fn(),
      get: vi.fn(),
      getMapping: vi.fn(),
      putMapping: vi.fn(),
      getSettings: vi.fn(),
      putSettings: vi.fn(),
      delete: vi.fn(),
      refresh: vi.fn()
    }
  };
}

function responseError(statusCode: number) {
  return Object.assign(new Error("provider response detail"), {
    meta: { statusCode }
  });
}
