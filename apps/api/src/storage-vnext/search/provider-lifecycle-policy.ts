import {
  isSearchProviderKind,
  type SearchProviderKind
} from "../../application/ports/search-provider-runtime.js";

export type SearchProviderProjectionState = {
  searchAvailable: boolean;
  nonSearchAvailable: true;
  maintenanceRequired: boolean;
  reasonCode: "search_provider_adoption_required" | null;
};

export type SearchProviderMaintenancePlan = {
  scopes: readonly string[];
  providerAdoption: boolean;
};

export function createSearchProviderLifecyclePolicy(input: {
  selectedProvider: SearchProviderKind;
}) {
  if (!isSearchProviderKind(input.selectedProvider)) {
    throw new Error("Invalid selected search provider");
  }

  return {
    inspectProjection(projection: {
      activeProvider: SearchProviderKind | null;
    }): SearchProviderProjectionState {
      const matches = projection.activeProvider === input.selectedProvider;
      return {
        searchAvailable: matches,
        nonSearchAvailable: true,
        maintenanceRequired: !matches,
        reasonCode: matches ? null : "search_provider_adoption_required"
      };
    },

    planMaintenance(plan: {
      trigger: "automatic" | "manual";
      activeProvider: SearchProviderKind | null;
      dueScopes: readonly string[];
    }): SearchProviderMaintenancePlan {
      const providerAdoption = plan.activeProvider !== input.selectedProvider;
      if (plan.trigger === "automatic" && providerAdoption) {
        return {
          scopes: plan.dueScopes.filter((scope) => scope !== "search"),
          providerAdoption: false
        };
      }
      if (plan.trigger === "manual" && providerAdoption) {
        return {
          scopes: uniqueScopes([...plan.dueScopes, "search"]),
          providerAdoption: true
        };
      }
      return {
        scopes: uniqueScopes(plan.dueScopes),
        providerAdoption: false
      };
    },

    planNewKnowledgeBase() {
      return {
        searchProvider: input.selectedProvider,
        indexSearch: true as const
      };
    },

    canResumeOperation(operation: {
      operationProvider: SearchProviderKind;
    }): boolean {
      return operation.operationProvider === input.selectedProvider;
    },

    canActivateProjection(candidate: {
      candidateProvider: SearchProviderKind;
      validated: boolean;
      requestedByCurrentMaintenance: boolean;
    }): boolean {
      return candidate.candidateProvider === input.selectedProvider
        && candidate.validated
        && candidate.requestedByCurrentMaintenance;
    }
  };
}

function uniqueScopes(scopes: readonly string[]): readonly string[] {
  return [...new Set(scopes)];
}
