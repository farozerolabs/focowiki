import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const composeFiles = [
  "docker-compose.yml.example",
  "docker-compose.dev.yml.example",
  "docker-compose.local.yml.example",
  "docker-compose.local.yml"
] as const;
const runtimeComposeFiles = composeFiles.filter((path) =>
  path !== "docker-compose.local.yml"
);

describe("search provider Compose contract", () => {
  it("uses OpenSearch 3.8.0 as the explicit template default", () => {
    expect(read(".env.example")).toContain("SEARCH_PROVIDER=opensearch");
    expect(read(".env.example")).toContain("COMPOSE_PROFILES=opensearch");
    expect(read(".env.dev.example")).toContain("SEARCH_PROVIDER=opensearch");
    for (const path of composeFiles) {
      expect(read(path), path).toContain(
        "image: opensearchproject/opensearch:3.8.0"
      );
    }
  });

  it("keeps provider services under separate profiles and uses one shared initializer", () => {
    for (const path of composeFiles) {
      const compose = read(path);
      expect(service(compose, "opensearch"), path).toContain(
        'profiles: ["opensearch"]'
      );
      expect(service(compose, "meilisearch"), path).toContain(
        'profiles: ["meilisearch"]'
      );
      expect(compose, path).not.toContain("bundled-search");
    }
    for (const path of runtimeComposeFiles) {
      const compose = read(path);
      expect(service(compose, "search-init"), path).toContain(
        'profiles: ["opensearch", "meilisearch"]'
      );
      for (const obsolete of [
        "meilisearch-init",
        "opensearch-security-init",
        "opensearch-security-config",
        "opensearch-init"
      ]) expect(service(compose, obsolete), `${path}:${obsolete}`).toBe("");
    }
  });

  it("passes common identity and optional inactive-provider variables", () => {
    for (const path of runtimeComposeFiles) {
      const compose = read(path);
      const runtime = anchor(compose, "x-runtime-environment");
      expect(runtime, path).toContain("SEARCH_PROVIDER:");
      expect(runtime, path).toContain("SEARCH_INDEX_PREFIX:");
      expect(runtime, path).not.toContain("MEILI_INDEX_PREFIX");
      expect(runtime, path).not.toMatch(
        /\$\{(?:MEILI|OPENSEARCH)_[A-Z0-9_]+:\?/u
      );
      expect(compose, path).not.toMatch(
        /\$\{(?:MEILI|OPENSEARCH)_[A-Z0-9_]+:\?/u
      );
    }
  });

  it("keeps local OpenSearch single-node, bounded, insecure, and loopback-only", () => {
    for (const path of [
      "docker-compose.dev.yml.example",
      "docker-compose.local.yml.example",
      "docker-compose.local.yml"
    ]) {
      const opensearch = service(read(path), "opensearch");
      expect(opensearch, path).toContain('discovery.type: "single-node"');
      expect(opensearch, path).toContain('DISABLE_SECURITY_PLUGIN: "true"');
      expect(opensearch, path).toContain("OPENSEARCH_JAVA_OPTS:");
      expect(opensearch, path).toMatch(/127\.0\.0\.1:\$\{OPENSEARCH_PORT[^\n]*:9200/u);
    }
  });

  it("documents the provider matrix without adding provider fields to Admin UI", () => {
    for (const path of [".env.example", ".env.dev.example"] as const) {
      const env = read(path);
      expect(env).toContain("SEARCH_INDEX_PREFIX=");
      expect(env).toContain("OPENSEARCH_URL=");
      expect(env).toContain("OPENSEARCH_AUTH_MODE=");
      expect(env).toContain("MEILI_HOST=");
      expect(env).not.toContain("MEILI_INDEX_PREFIX=");
    }
    const admin = read("apps/admin/src/components/settings-panel.tsx");
    expect(admin).not.toContain("SEARCH_PROVIDER");
    expect(admin).not.toContain("OPENSEARCH_URL");
  });

  it("makes bundled production OpenSearch a one-password automatic TLS deployment", () => {
    const env = read(".env.example");
    const compose = read("docker-compose.yml.example");
    const searchInit = service(compose, "search-init");
    const opensearch = service(compose, "opensearch");

    expect(env).toContain("OPENSEARCH_ADMIN_PASSWORD=<generate-an-opensearch-admin-password>");
    expect(env).not.toContain("OPENSEARCH_BOOTSTRAP_PASSWORD=");
    expect(env).not.toContain("OPENSEARCH_INITIAL_ADMIN_PASSWORD=");
    expect(searchInit).toContain(
      'command: ["node", "apps/api/runtime/search-init.mjs"]'
    );
    expect(searchInit).toContain("SEARCH_PROVIDER:");
    expect(searchInit).toContain("SEARCH_INDEX_PREFIX:");
    expect(searchInit).toContain("OPENSEARCH_ADMIN_PASSWORD:");
    expect(searchInit).toContain("./opensearch-security:/app/opensearch-security");
    expect(searchInit).toContain("./runtime-secrets:/app/runtime-secrets");
    expect(opensearch).toContain(
      "search-init:\n        condition: service_completed_successfully"
    );
    expect(opensearch).toContain('DISABLE_INSTALL_DEMO_CONFIG: "true"');
    expect(opensearch).toContain(
      "plugins.security.allow_default_init_securityindex: true"
    );
    expect(opensearch).not.toContain("plugins.security.allow_unsafe_democertificates");
    expect(opensearch).not.toContain("OPENSEARCH_INITIAL_ADMIN_PASSWORD");
    expect(opensearch).toContain(
      "./opensearch-security/current:/usr/share/opensearch/config/focowiki-security:ro"
    );
    expect(opensearch).toContain(
      "./opensearch-security/current/opensearch-security:/usr/share/opensearch/config/opensearch-security:ro"
    );
    expect(opensearch).toContain(
      "plugins.security.ssl.http.pemcert_filepath: focowiki-security/node.pem"
    );
    expect(opensearch).toContain(
      "plugins.security.ssl.transport.pemcert_filepath: focowiki-security/node.pem"
    );
    expect(opensearch).not.toContain("ports:");
    expect(compose).not.toContain("${OPENSEARCH_ADMIN_PASSWORD:?");
    expect(compose).not.toContain("./opensearch-security/root-ca.pem:");
    expect(compose).not.toContain("./opensearch-security/node.pem:");
    expect(compose).not.toContain("./opensearch-security/admin.pem:");
    expect(read("Dockerfile")).toContain("apk add --no-cache libstdc++ openssl su-exec");
    expect(read("Dockerfile")).toContain("apps/api/runtime/search-init.mjs");
    expect(read("apps/api/scripts/build-runtime.mjs")).toContain(
      '"search-init": "src/search-init-main.ts"'
    );
    expect(read("apps/api/scripts/build-runtime.mjs")).not.toMatch(
      /meilisearch-bootstrap|opensearch-bootstrap|opensearch-security-init/u
    );
    expect(read(".gitignore")).toContain("opensearch-security/");
  });

  it("orders initialization before the selected bundled provider without blocking external providers", () => {
    for (const path of runtimeComposeFiles) {
      const compose = read(path);
      const searchInit = service(compose, "search-init");
      const migrate = service(compose, "migrate");
      expect(searchInit, path).toContain(
        "meilisearch:\n        condition: service_healthy\n        required: false"
      );
      expect(service(compose, "opensearch"), path).toContain(
        "search-init:\n        condition: service_completed_successfully"
      );
      expect(migrate, path).toContain(
        "search-init:\n        condition: service_completed_successfully\n        required: false"
      );
    }
  });

  it("does not impose bundled TLS or admin-password inputs on external OpenSearch", () => {
    const compose = read("docker-compose.yml.example");
    const runtime = anchor(compose, "x-runtime-environment");

    expect(runtime).toContain('OPENSEARCH_ADMIN_PASSWORD: ""');
    expect(runtime).not.toContain("OPENSEARCH_ADMIN_PASSWORD: ${");
    expect(runtime).not.toContain("OPENSEARCH_SECURITY_DIR");
    expect(runtime).toContain("OPENSEARCH_AUTH_MODE:");
    expect(runtime).toContain("OPENSEARCH_CA_FILE:");
    expect(runtime).toContain("OPENSEARCH_AWS_REGION:");
    expect(runtime).toContain("OPENSEARCH_AWS_SERVICE:");
  });

  it("documents complete stopped-stack bundled TLS rotation state", () => {
    for (const path of [
      "docs/deployment/docker-compose.md",
      "docs/zh-CN/deployment/docker-compose.md"
    ]) {
      const rotation = read(path).split(/## (?:Rotate Bundled OpenSearch TLS|轮换模板附带 OpenSearch 的 TLS)/u)[1]
        ?.split("\n## ")[0] ?? "";
      expect(rotation, path).toContain("opensearch-security");
      expect(rotation, path).toContain("runtime-secrets/opensearch-password");
      expect(rotation, path).toContain("runtime-secrets/opensearch-ca.pem");
    }
  });
});

function read(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

function service(compose: string, name: string): string {
  const match = new RegExp(`^  ${name}:$`, "mu").exec(compose);
  if (!match) return "";
  const start = match.index;
  const remainder = compose.slice(start + match[0].length + 1);
  const next = /^  [a-zA-Z0-9_-]+:$/mu.exec(remainder);
  const end = next
    ? start + match[0].length + 1 + next.index
    : compose.length;
  return compose.slice(start, end < 0 ? compose.length : end);
}

function anchor(compose: string, name: string): string {
  const start = compose.indexOf(`${name}:`);
  if (start < 0) return "";
  const end = compose.indexOf("\n\n", start);
  return compose.slice(start, end < 0 ? compose.length : end);
}
