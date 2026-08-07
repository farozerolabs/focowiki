import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

type Provider = "meilisearch" | "opensearch";
type ProjectionState = {
  searchAvailable: boolean;
  nonSearchAvailable: boolean;
  maintenanceRequired: boolean;
  reasonCode: string | null;
};
type MaintenancePlan = {
  scopes: readonly string[];
  providerAdoption: boolean;
};
type ProviderLifecyclePolicy = {
  inspectProjection(input: {
    activeProvider: Provider | null;
  }): ProjectionState;
  planMaintenance(input: {
    trigger: "automatic" | "manual";
    activeProvider: Provider | null;
    dueScopes: readonly string[];
  }): MaintenancePlan;
  planNewKnowledgeBase(): {
    searchProvider: Provider;
    indexSearch: boolean;
  };
  canResumeOperation(input: { operationProvider: Provider }): boolean;
  canActivateProjection(input: {
    candidateProvider: Provider;
    validated: boolean;
    requestedByCurrentMaintenance: boolean;
  }): boolean;
};

let createPolicy:
  | ((input: { selectedProvider: Provider }) => ProviderLifecyclePolicy)
  | undefined;

beforeAll(async () => {
  const modulePath = resolve(
    import.meta.dirname,
    "../src/storage-vnext/search/provider-lifecycle-policy.ts"
  );
  const loaded = await import(/* @vite-ignore */ pathToFileURL(modulePath).href)
    .catch(() => ({})) as {
      createSearchProviderLifecyclePolicy?: typeof createPolicy;
    };
  createPolicy = loaded.createSearchProviderLifecyclePolicy;
});

describe("storage vNext search provider lifecycle Red contract", () => {
  it("keeps non-search reads available while provider mismatch disables search", () => {
    const policy = policyFor("opensearch");

    expect(policy.inspectProjection({ activeProvider: "meilisearch" })).toEqual({
      searchAvailable: false,
      nonSearchAvailable: true,
      maintenanceRequired: true,
      reasonCode: "search_provider_adoption_required"
    });
  });

  it("never adopts a provider through automatic maintenance", () => {
    const policy = policyFor("opensearch");

    expect(policy.planMaintenance({
      trigger: "automatic",
      activeProvider: "meilisearch",
      dueScopes: ["search"]
    })).toEqual({ scopes: [], providerAdoption: false });
  });

  it("allows independent non-search automatic repair during mismatch", () => {
    const policy = policyFor("opensearch");

    expect(policy.planMaintenance({
      trigger: "automatic",
      activeProvider: "meilisearch",
      dueScopes: ["tree", "search", "graph"]
    })).toEqual({
      scopes: ["tree", "graph"],
      providerAdoption: false
    });
  });

  it("allows the existing manual action to adopt the selected provider", () => {
    const policy = policyFor("opensearch");

    expect(policy.planMaintenance({
      trigger: "manual",
      activeProvider: "meilisearch",
      dueScopes: []
    })).toEqual({ scopes: ["search"], providerAdoption: true });
  });

  it("indexes a new knowledge base with the selected provider", () => {
    expect(policyFor("opensearch").planNewKnowledgeBase()).toEqual({
      searchProvider: "opensearch",
      indexSearch: true
    });
  });

  it("rejects wrong-provider resume and stale-index reactivation", () => {
    const policy = policyFor("opensearch");

    expect(policy.canResumeOperation({ operationProvider: "meilisearch" }))
      .toBe(false);
    expect(policy.canActivateProjection({
      candidateProvider: "opensearch",
      validated: true,
      requestedByCurrentMaintenance: false
    })).toBe(false);
  });

  it("requires fresh manual validation after switching back", () => {
    const policy = policyFor("meilisearch");

    expect(policy.inspectProjection({ activeProvider: "opensearch" }))
      .toMatchObject({ searchAvailable: false, maintenanceRequired: true });
    expect(policy.canActivateProjection({
      candidateProvider: "meilisearch",
      validated: true,
      requestedByCurrentMaintenance: true
    })).toBe(true);
  });
});

function policyFor(provider: Provider): ProviderLifecyclePolicy {
  if (!createPolicy) {
    throw new Error("Search provider lifecycle policy is unavailable");
  }
  return createPolicy({ selectedProvider: provider });
}
