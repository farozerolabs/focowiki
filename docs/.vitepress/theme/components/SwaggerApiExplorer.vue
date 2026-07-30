<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import localeCopies from "../../openapi-locales.json";
import { createSwaggerApiExplorerConfig } from "../swagger-api-explorer-config";
import { localizeSwaggerSpec } from "../swagger-api-explorer-localization";
import {
  searchSwaggerOperations,
  type SwaggerOperationSearchResult
} from "../swagger-api-explorer-search";

const props = defineProps<{
  loadingText: string;
  failureText: string;
  downloadText: string;
  searchLabel: string;
  searchPlaceholder: string;
  noResultsText: string;
  locale?: "en-US" | "zh-CN";
}>();

const contractPath = "/openapi/focowiki-openapi.json";
const stylesheetPath = "/vendor/swagger-ui/swagger-ui.css";
const status = ref<"loading" | "ready" | "failed">("loading");
const swaggerRoot = ref<HTMLElement>();
const contract = ref<Record<string, unknown>>({});
const searchQuery = ref("");
const searchResults = computed(() =>
  searchSwaggerOperations(contract.value, searchQuery.value)
);
let stylesheetElement: HTMLLinkElement | undefined;
let themeObserver: MutationObserver | undefined;

function openSearchResult(result: SwaggerOperationSearchResult) {
  const tagId = result.tag.replace(/\s+/g, "_");
  const operationId = `operations-${tagId}-${result.operationId}`;
  const openOperation = () => {
    const operation = document.getElementById(operationId);
    if (!operation) {
      return false;
    }
    if (!operation.classList.contains("is-open")) {
      operation.querySelector<HTMLButtonElement>(".opblock-summary-control")?.click();
    } else {
      window.location.hash = result.fragment.slice(1);
    }
    operation.scrollIntoView({ behavior: "smooth", block: "start" });
    return true;
  };

  if (openOperation()) {
    return;
  }

  document.getElementById(`operations-tag-${tagId}`)?.click();
  let remainingFrames = 12;
  const openWhenReady = () => {
    if (openOperation() || remainingFrames === 0) {
      return;
    }
    remainingFrames -= 1;
    requestAnimationFrame(openWhenReady);
  };
  requestAnimationFrame(openWhenReady);
}

onMounted(async () => {
  try {
    const response = await fetch(contractPath, {
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) {
      throw new Error(`Contract request failed with status ${response.status}.`);
    }
    const downloadedSpec = (await response.json()) as Record<string, unknown>;
    const spec = localizeSwaggerSpec(
      downloadedSpec,
      props.locale === "zh-CN" ? localeCopies["zh-CN"] : undefined
    );
    contract.value = spec;
    const { default: createSwaggerUi } = await import(
      "swagger-ui-dist/swagger-ui-es-bundle.js"
    );
    if (!swaggerRoot.value || typeof createSwaggerUi !== "function") {
      throw new Error("Swagger UI could not be initialized.");
    }
    stylesheetElement = document.createElement("link");
    stylesheetElement.rel = "stylesheet";
    stylesheetElement.href = stylesheetPath;
    stylesheetElement.dataset.swaggerApiExplorer = "true";
    document.head.append(stylesheetElement);
    const syncTheme = () => {
      document.documentElement.classList.toggle(
        "dark-mode",
        document.documentElement.classList.contains("dark")
      );
    };
    syncTheme();
    themeObserver = new MutationObserver(syncTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"]
    });
    createSwaggerUi(
      createSwaggerApiExplorerConfig({
        domNode: swaggerRoot.value,
        spec
      })
    );
    status.value = "ready";
  } catch {
    status.value = "failed";
  }
});

onBeforeUnmount(() => {
  if (swaggerRoot.value) {
    swaggerRoot.value.replaceChildren();
  }
  themeObserver?.disconnect();
  document.documentElement.classList.remove("dark-mode");
  stylesheetElement?.remove();
});
</script>

<template>
  <section class="swagger-explorer-shell">
    <div
      v-if="status === 'loading'"
      class="swagger-explorer-status"
      role="status"
      aria-live="polite"
    >
      {{ loadingText }}
    </div>
    <div
      v-if="status === 'failed'"
      class="swagger-explorer-status swagger-explorer-failure"
      role="alert"
    >
      <p>{{ failureText }}</p>
      <a :href="contractPath" download>{{ downloadText }}</a>
    </div>
    <div v-if="status === 'ready'" class="swagger-explorer-search">
      <label for="swagger-operation-search">{{ props.searchLabel }}</label>
      <input
        id="swagger-operation-search"
        v-model="searchQuery"
        type="search"
        :placeholder="props.searchPlaceholder"
        autocomplete="off"
      />
      <ul v-if="searchResults.length > 0" class="swagger-explorer-search-results">
        <li v-for="result in searchResults" :key="`${result.method}:${result.path}`">
          <a :href="result.fragment" @click.prevent="openSearchResult(result)">
            <span class="swagger-explorer-method">{{ result.method }}</span>
            <span class="swagger-explorer-result-copy">
              <strong>{{ result.summary }}</strong>
              <code>{{ result.path }}</code>
            </span>
          </a>
        </li>
      </ul>
      <p v-else-if="searchQuery.trim().length > 0" class="swagger-explorer-no-results">
        {{ props.noResultsText }}
      </p>
    </div>
    <div
      ref="swaggerRoot"
      class="swagger-explorer-root"
      :class="{ 'is-ready': status === 'ready' }"
    />
    <footer v-if="status === 'ready'" class="swagger-explorer-footer">
      <a :href="contractPath" download>{{ downloadText }}</a>
    </footer>
  </section>
</template>

<style scoped>
.swagger-explorer-shell {
  min-width: 0;
}

.swagger-explorer-status {
  padding: 20px 0;
  color: var(--vp-c-text-2);
}

.swagger-explorer-failure {
  border-top: 1px solid var(--vp-c-divider);
  border-bottom: 1px solid var(--vp-c-divider);
}

.swagger-explorer-failure p {
  margin: 0 0 8px;
}

.swagger-explorer-root {
  display: none;
  min-width: 0;
}

.swagger-explorer-root.is-ready {
  display: block;
}

.swagger-explorer-search {
  margin: 20px 0 28px;
}

.swagger-explorer-search label {
  display: block;
  margin-bottom: 8px;
  font-weight: 600;
}

.swagger-explorer-search input {
  width: 100%;
  min-height: 42px;
  padding: 8px 12px;
  color: var(--vp-c-text-1);
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
}

.swagger-explorer-search input:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}

.swagger-explorer-search-results {
  display: grid;
  gap: 6px;
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
}

.swagger-explorer-search-results li {
  margin: 0;
}

.swagger-explorer-search-results a {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  color: var(--vp-c-text-1);
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
}

.swagger-explorer-method {
  flex: 0 0 52px;
  color: var(--vp-c-brand-1);
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  font-weight: 700;
}

.swagger-explorer-result-copy {
  min-width: 0;
}

.swagger-explorer-result-copy strong,
.swagger-explorer-result-copy code {
  display: block;
  overflow-wrap: anywhere;
}

.swagger-explorer-result-copy code {
  margin-top: 3px;
  color: var(--vp-c-text-2);
  font-size: 12px;
}

.swagger-explorer-no-results {
  margin: 12px 0 0;
  color: var(--vp-c-text-2);
}

.swagger-explorer-footer {
  margin-top: 24px;
  padding-top: 16px;
  border-top: 1px solid var(--vp-c-divider);
  font-size: 14px;
}
</style>
