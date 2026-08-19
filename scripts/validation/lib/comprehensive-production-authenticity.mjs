import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  buildAdminApiInventory,
  buildAdminUiInventory,
  buildConfigurationInventory,
  walkFiles
} from "./comprehensive-code-inventory.mjs";
import {
  buildPostgresInventory,
  buildSubsystemInventories
} from "./comprehensive-persistence-inventory.mjs";
import { buildComprehensiveSourceInventory } from "./comprehensive-release-inventory.mjs";

const WORKER_BINDINGS = Object.freeze({
  api: "apps/api/src/main.ts",
  worker: "apps/api/src/worker-main.ts",
  "search-init": "apps/api/src/search-init-main.ts",
  migrate: "apps/api/src/db/migrate.ts"
});
const EXTERNAL_SETTING_CONSUMERS = Object.freeze({
  COMPOSE_PROFILES: "docker-compose-cli"
});
const ADMIN_SETTING_UI_SOURCES = new Set([
  "apps/admin/src/components/settings-panel.tsx",
  "apps/admin/src/components/embedding-settings-panel.tsx",
  "apps/admin/src/components/reranker-settings-panel.tsx"
]);
const COMPATIBILITY_FALLBACKS = Object.freeze([
  {
    id: "search-semantic-to-lexical",
    source: "apps/api/src/storage-vnext/search/semantic-search.ts",
    test: "apps/api/test/storage-vnext-semantic-search.test.ts"
  },
  {
    id: "search-composition-lexical-port",
    source: "apps/api/src/main.ts",
    test: "apps/api/test/storage-vnext-semantic-search.test.ts"
  },
  {
    id: "reranker-preserves-candidate-order",
    source: "apps/api/src/semantic/reranker/gateway.ts",
    test: "apps/api/test/reranker-gateway.test.ts"
  },
  {
    id: "semantic-lane-preserves-safe-candidates",
    source: "apps/api/src/semantic/search/orchestrator.ts",
    test: "apps/api/test/semantic-search-orchestrator.test.ts"
  },
  {
    id: "okf-v01-generated-time",
    source: "packages/okf/src/v02/parsing.ts",
    test: "apps/api/test/okf-v02-red.test.ts"
  }
]);
const PRODUCTION_ROOTS = Object.freeze([
  "apps/api/src/main.ts",
  "apps/api/src/db/migrate.ts",
  "apps/api/src/db/migration-preflight-main.ts",
  "apps/api/src/search-init-main.ts",
  "apps/api/src/worker-main.ts",
  "apps/admin/src/main.tsx",
  "packages/okf/src/index.ts"
]);
const VALIDATION_ONLY_ROOTS = Object.freeze([
  "apps/api/src/storage-vnext/bootstrap/main.ts"
]);
const REVIEWED_DYNAMIC_TEST_ONLY_MODULES = new Set();
const REVIEWED_DORMANT_LIBRARY_MODULES = new Set([
  "apps/admin/src/components/ui/breadcrumb.tsx"
]);
const TEST_SUPPORT_PATTERN = /(?:^|\/|[-_.])(?:test|tests|fixture|fixtures|mock|mocks|fake|fakes|stub|stubs|benchmark|benchmarks)(?:$|\/|[-_.])/iu;
const TEST_DOUBLE_SELECTOR_PATTERN = /\b(?:mock|fake|stub|fixture|in[-_ ]?memory|test[-_ ]?(?:transport|adapter|provider|repository|client))\b/iu;

export function buildProductionWiringGraph(repositoryRoot) {
  const files = productionFiles(repositoryRoot);
  const sourceByRelative = new Map(files.map((filePath) => [relative(repositoryRoot, filePath), filePath]));
  for (const composeFile of [
    "docker-compose.yml.example",
    "docker-compose.dev.yml.example",
    "docker-compose.local.yml.example"
  ]) sourceByRelative.set(composeFile, path.join(repositoryRoot, composeFile));
  for (const auxiliary of [
    "Dockerfile",
    "apps/admin/vite.config.ts",
    "deploy/docker/api-entrypoint.sh",
    "deploy/nginx/default.conf.template"
  ]) sourceByRelative.set(auxiliary, path.join(repositoryRoot, auxiliary));
  const sourceText = new Map([...sourceByRelative].map(([name, filePath]) => [name, fs.readFileSync(filePath, "utf8")]));
  const nodes = [...sourceByRelative].map(([source]) => node(`source:${source}`, "source", {
    source,
    layer: sourceLayer(source)
  }));
  const edges = [];

  addInventorySurface({
    repositoryRoot,
    inventory: buildComprehensiveSourceInventory({ repositoryRoot }),
    sourceText,
    nodes,
    edges
  });

  for (const [source, text] of sourceText) {
    if (!/\.[cm]?[jt]sx?$/u.test(source)) continue;
    for (const specifier of imports(text)) {
      const target = resolveImport(source, specifier, sourceByRelative);
      const testSupport = TEST_SUPPORT_PATTERN.test(specifier) || (target && TEST_SUPPORT_PATTERN.test(target));
      edges.push(edge(
        testSupport ? "imports-test-support" : "imports",
        `source:${source}`,
        target ? `source:${target}` : `external:${specifier}`
      ));
      if (!target) addNode(nodes, node(`external:${specifier}`, "external-dependency", { name: specifier }));
    }
  }

  const configuration = buildConfigurationInventory(repositoryRoot);
  const environmentNames = new Set(configuration
    .filter((item) => item.kind === "environment-field")
    .map((item) => item.name));
  for (const name of environmentNames) {
    const setting = node(`environment-field:${name}`, "environment-field", { name, acceptedSetting: true });
    addNode(nodes, setting);
    for (const [source, text] of sourceText) {
      if (containsIdentifier(text, name)) edges.push(edge("consumes-setting", setting.id, `source:${source}`));
    }
    if (EXTERNAL_SETTING_CONSUMERS[name]) {
      const consumer = `external:${EXTERNAL_SETTING_CONSUMERS[name]}`;
      addNode(nodes, node(consumer, "external-dependency", { name: EXTERNAL_SETTING_CONSUMERS[name] }));
      edges.push(edge("consumes-setting", setting.id, consumer));
    }
  }

  const adminSettingsPanel = [...ADMIN_SETTING_UI_SOURCES]
    .map((source) => sourceText.get(source) ?? "").join("\n");
  for (const item of acceptedRuntimeFields(repositoryRoot)) {
    const setting = node(`runtime-field:${item.id}`, "runtime-field", {
      name: item.name,
      section: item.section,
      source: item.source,
      acceptedSetting: true,
      presented: adminSettingsPanel.includes(item.name)
    });
    addNode(nodes, setting);
    for (const [source, text] of sourceText) {
      if (source !== item.source && !ADMIN_SETTING_UI_SOURCES.has(source) && containsIdentifier(text, item.name)) {
        edges.push(edge("consumes-setting", setting.id, `source:${source}`));
      }
    }
  }

  for (const [source, text] of sourceText) {
    if (!source.startsWith("apps/api/src/") || !/(?:ports?\.ts$|\/ports\/)/u.test(source)) continue;
    const portNames = [...text.matchAll(/export\s+(?:type|interface)\s+([A-Za-z_$][\w$]*Port)\b/gmu)]
      .map((match) => match[1]);
    const aggregateConsumers = [...sourceText]
      .filter(([consumer, consumerText]) => {
        return consumer !== source
          && consumer.startsWith("apps/api/src/")
          && portNames.some((name) => consumerText.includes(name));
      })
      .map(([consumer]) => consumer);
    for (const portName of portNames) {
      const port = node(`port:${portName}:${source}`, "port", { name: portName, source });
      addNode(nodes, port);
      const directConsumers = [];
      for (const [consumer, consumerText] of sourceText) {
        if (consumer !== source && consumer.startsWith("apps/api/src/") && consumerText.includes(portName)) {
          directConsumers.push(consumer);
          edges.push(edge("binds-port", port.id, `source:${consumer}`));
        }
      }
      if (directConsumers.length === 0 && text.split(portName).length > 2) {
        for (const consumer of aggregateConsumers) {
          edges.push(edge("binds-port", port.id, `source:${consumer}`, "aggregate-port"));
        }
      }
    }
  }

  const postgres = buildPostgresInventory(repositoryRoot);
  for (const item of postgres.filter((candidate) => candidate.kind === "table")) {
    const tableName = item.table.split(".").at(-1);
    addNode(nodes, node(`postgres-table:${tableName}`, "postgres-table", { name: tableName, source: item.source }));
  }
  for (const item of postgres.filter((candidate) => candidate.kind === "critical-query-path")) {
    edges.push(edge("queries-table", `postgres-table:${item.table}`, `source:${item.source}`, item.id));
  }

  for (const item of buildAdminApiInventory(repositoryRoot).filter((candidate) => candidate.kind === "route")) {
    const route = node(`admin-route:${item.method}:${item.path}`, "admin-route", {
      method: item.method,
      path: item.path,
      source: item.source
    });
    addNode(nodes, route);
    edges.push(edge("defines-route", `source:${item.source}`, route.id));
  }
  for (const item of buildAdminUiInventory(repositoryRoot).filter((candidate) => candidate.kind === "control")) {
    const control = node(`ui-control:${item.id}`, "ui-control", { source: item.source, line: item.line, name: item.name });
    addNode(nodes, control);
    edges.push(edge("presents", `source:${item.source}`, control.id));
  }

  for (const [role, source] of Object.entries(WORKER_BINDINGS)) {
    const roleNode = node(`worker-role:${role}`, "worker-role", { role });
    addNode(nodes, roleNode);
    edges.push(edge("starts-role", `source:${source}`, roleNode.id));
  }

  const generated = buildSubsystemInventories(repositoryRoot).generated;
  for (const item of generated.filter((candidate) => candidate.kind === "generated-symbol")) {
    const output = node(`generated-output:${item.id}`, "generated-output", {
      name: item.name,
      source: item.source
    });
    addNode(nodes, output);
    edges.push(edge("produces-output", `source:${item.source}`, output.id));
  }

  for (const fallback of COMPATIBILITY_FALLBACKS) {
    if (!sourceByRelative.has(fallback.source) || !fs.existsSync(path.join(repositoryRoot, fallback.test))) {
      throw new Error(`Compatibility fallback evidence is missing: ${fallback.id}`);
    }
    const fallbackNode = node(`compatibility-fallback:${fallback.id}`, "compatibility-fallback", fallback);
    addNode(nodes, fallbackNode);
    edges.push(edge("declares-fallback", `source:${fallback.source}`, fallbackNode.id));
    edges.push(edge("verified-by-test", fallbackNode.id, `test:${fallback.test}`));
  }

  const reachability = classifySourceReachability(repositoryRoot, sourceByRelative, edges);
  for (const sourceNode of nodes.filter((item) => item.kind === "source")) {
    const classification = reachability.get(sourceNode.source);
    if (classification) sourceNode.reachability = classification;
  }
  const findings = [
    ...buildSuspiciousProductionFindings(repositoryRoot, files),
    ...buildProductionSelectorFindings(repositoryRoot),
    ...[...reachability]
      .filter(([, classification]) => classification !== "production-runtime")
      .map(([source, classification]) => ({
        id: `finding:runtime-unreachable:${source}`,
        kind: "runtime-unreachable",
        source,
        line: 1,
        classification,
        runtimeCaseRequired: classification === "dead-unreferenced-module",
        evidenceHash: hash(`${source}:${classification}`)
      }))
  ];

  return {
    schemaVersion: 1,
    nodes: uniqueById(nodes),
    edges: uniqueById(edges),
    findings: uniqueById(findings)
  };
}

export function assertProductionAuthenticity(graph) {
  if (graph.schemaVersion !== 1) throw new Error("Unsupported production authenticity graph");
  if (graph.edges.some((item) => item.kind === "imports-test-support")) {
    throw new Error("Production imports test support");
  }
  for (const setting of graph.nodes.filter((item) => item.acceptedSetting === true)) {
    if (setting.kind === "runtime-field" && setting.presented !== true) {
      throw new Error(`Accepted production setting is absent from Admin UI: ${setting.id}`);
    }
    if (!graph.edges.some((item) => item.kind === "consumes-setting" && item.from === setting.id)) {
      throw new Error(`Accepted production setting is disconnected: ${setting.id}`);
    }
  }
  for (const port of graph.nodes.filter((item) => item.kind === "port")) {
    if (!graph.edges.some((item) => item.kind === "binds-port" && item.from === port.id)) {
      throw new Error(`Production port has no binding: ${port.id}`);
    }
  }
  for (const role of graph.nodes.filter((item) => item.kind === "worker-role")) {
    const bindings = graph.edges.filter((item) => item.kind === "starts-role" && item.to === role.id);
    if (bindings.length !== 1) throw new Error(`Production worker binding cardinality mismatch: ${role.role}`);
  }
  for (const item of graph.nodes.filter((candidate) => candidate.kind === "surface-item")) {
    if (!graph.edges.some((candidate) => candidate.from === item.id && SURFACE_LINEAGE_EDGES.has(candidate.kind))) {
      throw new Error(`Production surface item has no authoritative lineage: ${item.id}`);
    }
  }
  for (const fallback of graph.nodes.filter((item) => item.kind === "compatibility-fallback")) {
    if (
      graph.edges.filter((item) => item.kind === "declares-fallback" && item.to === fallback.id).length !== 1
      || graph.edges.filter((item) => item.kind === "verified-by-test" && item.from === fallback.id).length !== 1
    ) {
      throw new Error(`Compatibility fallback is disconnected: ${fallback.id}`);
    }
  }
  for (const finding of graph.findings) {
    if (!finding.classification || finding.classification === "unreviewed" || !/^[a-f0-9]{64}$/u.test(finding.evidenceHash)) {
      throw new Error(`Suspicious production finding is unclassified: ${finding.id}`);
    }
    if (finding.classification === "dead-unreferenced-module") {
      throw new Error(`Production source is dead and unreferenced: ${finding.source}`);
    }
    if (finding.classification === "potentially-swallowed-error") {
      throw new Error(`Production catch path may swallow an error: ${finding.source}:${finding.line}`);
    }
    if (finding.classification === "production-test-double-selector") {
      throw new Error(`Production startup can select a test double: ${finding.source}:${finding.line}`);
    }
  }
}

function buildProductionSelectorFindings(repositoryRoot) {
  const exactFiles = [
    ...PRODUCTION_ROOTS,
    "apps/api/src/config.ts",
    "Dockerfile",
    "docker-compose.yml.example",
    "docker-compose.dev.yml.example",
    "docker-compose.local.yml.example",
    ".env.example",
    ".env.dev.example",
    ".env.local.example"
  ];
  const directoryFiles = ["apps/api/src/admin", "deploy/docker"].flatMap((root) =>
    walkFiles(path.join(repositoryRoot, root), (value) => /\.(?:ts|sh)$/u.test(value))
      .map((value) => relative(repositoryRoot, value))
  );
  const findings = [];
  for (const sourcePath of [...new Set([...exactFiles, ...directoryFiles])]) {
    const filePath = path.join(repositoryRoot, sourcePath);
    if (!fs.existsSync(filePath)) continue;
    const source = fs.readFileSync(filePath, "utf8");
    for (const match of source.matchAll(new RegExp(TEST_DOUBLE_SELECTOR_PATTERN.source, "gimu"))) {
      const line = source.slice(0, match.index).split("\n").length;
      findings.push({
        id: `finding:production-selector:${sourcePath}:${line}:${hash(match[0]).slice(0, 12)}`,
        kind: "production-selector",
        source: sourcePath,
        line,
        classification: "production-test-double-selector",
        runtimeCaseRequired: true,
        evidenceHash: hash(`${sourcePath}:${line}:${source.split("\n")[line - 1]?.trim() ?? ""}`)
      });
    }
  }
  return findings;
}

const SURFACE_LINEAGE_EDGES = new Set([
  "belongs-to-operation",
  "configures-setting",
  "implemented-by"
]);

function addInventorySurface(input) {
  const operationNodes = new Map(input.inventory.developerOpenApi
    .filter((item) => item.kind === "operation")
    .map((item) => [item.operationId, `surface:developerOpenApi:${item.id}`]));
  for (const [category, items] of Object.entries(input.inventory)) {
    for (const item of items) {
      const surface = node(`surface:${category}:${item.id}`, "surface-item", {
        category,
        itemKind: item.kind,
        source: item.source,
        sourceId: item.id
      });
      addNode(input.nodes, surface);

      if (category === "developerOpenApi" && item.kind !== "operation" && item.operationId) {
        const operationNode = operationNodes.get(item.operationId);
        if (!operationNode) throw new Error(`Developer OpenAPI surface operation is missing: ${item.id}`);
        input.edges.push(edge("belongs-to-operation", surface.id, operationNode));
        continue;
      }
      if (category === "configuration" && item.name && /environment/u.test(item.kind)) {
        input.edges.push(edge("configures-setting", surface.id, `environment-field:${item.name}`));
        continue;
      }
      if (category === "developerOpenApi" && item.kind === "operation") {
        const implementations = [...input.sourceText]
          .filter(([source, text]) => source.startsWith("apps/api/src/") && text.includes(item.operationId))
          .map(([source]) => source);
        if (implementations.length === 0) {
          throw new Error(`Developer OpenAPI operation has no production implementation source: ${item.operationId}`);
        }
        for (const implementation of implementations) {
          input.edges.push(edge("implemented-by", surface.id, `source:${implementation}`));
        }
        continue;
      }

      const source = typeof item.source === "string" ? item.source : "";
      if (!source || !fs.existsSync(path.join(input.repositoryRoot, source))) {
        throw new Error(`Production surface item has no exact source: ${surface.id}`);
      }
      addNode(input.nodes, node(`source:${source}`, "source", {
        source,
        layer: sourceLayer(source)
      }));
      input.edges.push(edge("implemented-by", surface.id, `source:${source}`));
    }
  }
}

export function buildProductionAuthenticitySnapshot(graph) {
  assertProductionAuthenticity(graph);
  const counts = Object.fromEntries([
    ...new Set(graph.nodes.map((item) => item.kind))
  ].sort().map((kind) => [kind, graph.nodes.filter((item) => item.kind === kind).length]));
  const edgeCounts = Object.fromEntries([
    ...new Set(graph.edges.map((item) => item.kind))
  ].sort().map((kind) => [kind, graph.edges.filter((item) => item.kind === kind).length]));
  const findingCounts = Object.fromEntries([
    ...new Set(graph.findings.map((item) => item.classification))
  ].sort().map((classification) => [
    classification,
    graph.findings.filter((item) => item.classification === classification).length
  ]));
  return {
    schemaVersion: 1,
    counts,
    edgeCounts,
    findingCounts,
    nodeHash: hash(graph.nodes.map(compactNode).sort(byId)),
    edgeHash: hash(graph.edges.map(compactEdge).sort(byId)),
    findingHash: hash(graph.findings.map(compactFinding).sort(byId))
  };
}

function buildSuspiciousProductionFindings(repositoryRoot, files) {
  const findings = [];
  const patterns = [
    { kind: "suspicious-name", pattern: /\b(?:fake|mock|stub|fixture|placeholder|noop|no-op|in-memory|hard-coded|always-empty|swallow(?:ed|ing)?)\b/gimu },
    { kind: "constant-state", pattern: /\b(?:status|state)\s*:\s*["'](?:success|completed|ready|active|empty)["']/gimu },
    { kind: "empty-result", pattern: /return\s+(?:Promise\.resolve\()?\s*(?:\[\]|\{\})\s*\)?\s*;/gimu },
    { kind: "error-normalization", pattern: /\.catch\(\(\)\s*=>\s*\(\{\}\)\)/gimu },
    { kind: "fixed-count", pattern: /\b(?:[A-Za-z][A-Za-z0-9]*Count|count|total)\s*:\s*\d+(?:_\d+)*\b/gmu },
    { kind: "fixed-model-identity", pattern: /\b(?:modelName|modelId|modelIdentity|model)\s*:\s*["'][^"'\n]+["']/gmu }
  ];
  for (const filePath of files) {
    const source = fs.readFileSync(filePath, "utf8");
    const sourcePath = relative(repositoryRoot, filePath);
    for (const { kind, pattern } of patterns) {
      for (const match of source.matchAll(pattern)) {
        const line = source.slice(0, match.index).split("\n").length;
        const lineText = source.split("\n")[line - 1]?.trim() ?? "";
        findings.push({
          id: `finding:${kind}:${sourcePath}:${line}:${hash(match[0]).slice(0, 12)}`,
          kind,
          source: sourcePath,
          line,
          classification: classifyFinding(kind, sourcePath, match[0]),
          runtimeCaseRequired: kind !== "suspicious-name" || !sourcePath.startsWith("apps/admin/src/"),
          evidenceHash: hash(`${sourcePath}:${line}:${lineText}`)
        });
      }
    }
    findings.push(...catchFindings(sourcePath, source));
  }
  return uniqueById(findings);
}

function classifyFinding(kind, source, token) {
  if (kind === "constant-state") return "explicit-domain-state";
  if (kind === "empty-result") return "explicit-empty-contract";
  if (kind === "error-normalization") return "explicit-error-normalization";
  if (kind === "fixed-count") return source.includes("openapi-")
    ? "contract-example-count"
    : "bounded-count-literal";
  if (kind === "fixed-model-identity") return source.includes("i18n/")
    ? "presentation-model-label"
    : source.includes("openapi-")
      ? "contract-model-example"
      : "fixed-model-identity-contract";
  if (/placeholder/iu.test(token) && source.startsWith("apps/admin/src/")) return "ui-placeholder-presentation";
  if (/placeholder/iu.test(token) && source === "apps/api/src/config.ts") return "production-secret-placeholder-rejection";
  if (/noop|no-op/iu.test(token) && source.includes("markdown-preview")) return "browser-security-rel-token";
  return "bounded-contract-term";
}

function catchFindings(sourcePath, source) {
  const findings = [];
  for (const match of source.matchAll(/\bcatch\s*(?:\([^)]*\))?\s*\{/gmu)) {
    const openIndex = (match.index ?? 0) + match[0].lastIndexOf("{");
    const closeIndex = matchingBrace(source, openIndex);
    if (closeIndex < 0) continue;
    const body = source.slice(openIndex + 1, closeIndex);
    const line = source.slice(0, match.index).split("\n").length;
    const classification = classifyCatchBody({
      body,
      before: source.slice(Math.max(0, (match.index ?? 0) - 240), match.index),
      after: source.slice(closeIndex + 1, closeIndex + 240)
    });
    findings.push({
      id: `finding:catch-path:${sourcePath}:${line}:${hash(match[0]).slice(0, 12)}`,
      kind: "catch-path",
      source: sourcePath,
      line,
      classification,
      runtimeCaseRequired: classification !== "explicit-error-propagation",
      evidenceHash: hash(`${sourcePath}:${line}:${body.trim()}`)
    });
  }
  return findings;
}

export function classifyCatchBody(input) {
  if (/\bthrow\b/u.test(input.body) || /^\s*throw\b/u.test(stripLeadingComments(input.after))) {
    return "explicit-error-propagation";
  }
  if (/\b(?:return|break|continue)\b/u.test(input.body)) return "explicit-safe-degradation";
  if (hasCatchSideEffect(input.body)) return "explicit-error-handling";
  if (/\.(?:destroy|close|kill|abort)\([^)]*\)\s*;?\s*\}?\s*$/u.test(input.before.trim())) {
    return "best-effort-cleanup";
  }
  return "potentially-swallowed-error";
}

function hasCatchSideEffect(body) {
  if (/(?:^|[;\n])\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*(?:=|\?\?=|\+=|-=)/u.test(body)) {
    return true;
  }
  for (const match of body.matchAll(/(?:\b[A-Za-z_$][\w$]*\?\.|\b[A-Za-z_$][\w$]*|\.[A-Za-z_$][\w$]*|\?\.[A-Za-z_$][\w$]*)\s*\(/gmu)) {
    const callee = match[0].replace(/[?.\s(]/gu, "");
    if (!["if", "for", "while", "switch", "catch"].includes(callee)) return true;
  }
  return false;
}

function stripLeadingComments(value) {
  return value.replace(/^\s*(?:(?:\/\/[^\n]*\n)|(?:\/\*[\s\S]*?\*\/\s*))*/u, "");
}

function matchingBrace(source, openIndex) {
  let depth = 0;
  let quote = null;
  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote && source[index - 1] !== "\\") quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function productionFiles(repositoryRoot) {
  return ["apps/api/src", "apps/admin/src", "packages/okf/src"].flatMap((root) =>
    walkFiles(path.join(repositoryRoot, root), (value) => {
      return /\.(?:ts|tsx)$/u.test(value)
        && !/\.(?:test|spec)\.(?:ts|tsx)$/u.test(value)
        && !/[\\/](?:test|tests|fixtures?|mocks?|fakes?|stubs?)[\\/]/iu.test(value);
    })
  );
}

function classifySourceReachability(repositoryRoot, sourceByRelative, graphEdges) {
  const importEdges = graphEdges.filter((item) => item.kind === "imports");
  const runtime = reachableSources(PRODUCTION_ROOTS, importEdges);
  const validationTargets = new Set(VALIDATION_ONLY_ROOTS);
  const testTargets = new Set();
  for (const supportFile of supportFiles(repositoryRoot)) {
    const supportSource = fs.readFileSync(supportFile, "utf8");
    const supportRelative = relative(repositoryRoot, supportFile);
    const targetSet = supportRelative.startsWith("scripts/validation/")
      ? validationTargets
      : testTargets;
    for (const specifier of imports(supportSource)) {
      const target = resolveImport(supportRelative, specifier, sourceByRelative);
      if (target) targetSet.add(target);
    }
  }
  const validation = reachableSources([...validationTargets], importEdges);
  const tests = reachableSources([...testTargets], importEdges);
  return new Map([...sourceByRelative.keys()]
    .filter((source) => /^(?:apps\/(?:api|admin)\/src|packages\/okf\/src)\//u.test(source))
    .map((source) => [
      source,
      runtime.has(`source:${source}`)
        ? "production-runtime"
        : REVIEWED_DORMANT_LIBRARY_MODULES.has(source)
          ? "dormant-library-module"
          : validation.has(`source:${source}`)
            ? "validation-only-module"
            : tests.has(`source:${source}`) || REVIEWED_DYNAMIC_TEST_ONLY_MODULES.has(source)
              ? "test-only-module"
              : "dead-unreferenced-module"
    ]));
}

function reachableSources(rootSources, edges) {
  const outgoing = new Map();
  for (const item of edges) {
    if (!outgoing.has(item.from)) outgoing.set(item.from, []);
    outgoing.get(item.from).push(item.to);
  }
  const reachable = new Set(rootSources.map((source) => `source:${source}`));
  const queue = [...reachable];
  while (queue.length > 0) {
    for (const target of outgoing.get(queue.shift()) ?? []) {
      if (reachable.has(target)) continue;
      reachable.add(target);
      queue.push(target);
    }
  }
  return reachable;
}

function supportFiles(repositoryRoot) {
  return ["apps/api/test", "apps/admin/test", "scripts/validation"].flatMap((root) =>
    walkFiles(path.join(repositoryRoot, root), (value) => /\.(?:ts|tsx|mjs)$/u.test(value))
  );
}

function sourceLayer(source) {
  if (source.startsWith("apps/admin/src/")) return "admin-ui";
  if (source.startsWith("packages/okf/src/")) return "okf-library";
  if (/(?:^|\/)main\.ts$/u.test(source) || /production-runtime\.ts$/u.test(source) || source.endsWith("server.ts")) return "composition";
  if (/(?:ports?\.ts$|\/ports\/)/u.test(source)) return "port";
  if (/(?:postgres|redis|s3|infrastructure|transport|object-store)/iu.test(source)) return "adapter";
  if (/(?:validation|validator)/iu.test(source)) return "validation";
  if (/(?:worker|queue|dispatch)/iu.test(source)) return "worker";
  if (source.startsWith("apps/api/src/domain/")) return "domain";
  if (source.startsWith("apps/api/src/application/")) return "application";
  return "api-runtime";
}

function acceptedRuntimeFields(repositoryRoot) {
  const definitions = [
    {
      source: "apps/api/src/runtime-settings/types.ts",
      types: {
        RuntimeWorkerPublicSettings: "worker",
        RuntimeGeneratedSettings: "generated",
        RuntimeGraphSettings: "graph",
        RuntimeMaintenanceSettings: "maintenance",
        RuntimeSearchSettings: "search",
        RuntimeSemanticSettings: "semantic",
        RuntimeModelConfigDraft: "model"
      }
    },
    {
      source: "apps/api/src/semantic/embedding/configuration.ts",
      types: { EmbeddingConfigurationDraft: "embedding" }
    },
    {
      source: "apps/api/src/semantic/reranker/configuration.ts",
      types: { RerankerConfigurationDraft: "reranker" }
    }
  ];
  const fields = [];
  for (const definition of definitions) {
    const source = fs.readFileSync(path.join(repositoryRoot, definition.source), "utf8");
    for (const [typeName, section] of Object.entries(definition.types)) {
      const body = namedTypeBody(source, typeName);
      for (const match of body.matchAll(/^\s{2}([a-z][A-Za-z0-9]*)\??:\s*/gmu)) {
        fields.push({
          id: `${section}.${match[1]}`,
          section,
          name: match[1],
          source: definition.source
        });
      }
    }
  }
  for (const group of ["adminLogin", "adminApi", "publicOpenApi"]) {
    for (const name of ["max", "windowSeconds"]) {
      fields.push({
        id: `rateLimits.${group}.${name}`,
        section: "rateLimits",
        name,
        source: "apps/api/src/config.ts"
      });
    }
  }
  return uniqueById(fields);
}

function namedTypeBody(source, typeName) {
  const startMatch = new RegExp(`export\\s+type\\s+${typeName}\\s*=\\s*\\{`, "u").exec(source);
  if (!startMatch) throw new Error(`Runtime setting type is missing: ${typeName}`);
  const openIndex = (startMatch.index ?? 0) + startMatch[0].lastIndexOf("{");
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, index);
    }
  }
  throw new Error(`Runtime setting type is unclosed: ${typeName}`);
}

function imports(source) {
  return [
    ...source.matchAll(/\bfrom\s+["']([^"']+)["']/gmu),
    ...source.matchAll(/^\s*import\s+["']([^"']+)["']/gmu),
    ...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/gmu)
  ].map((match) => match[1]);
}

function resolveImport(importer, specifier, sourceByRelative) {
  if (specifier === "@focowiki/okf" && sourceByRelative.has("packages/okf/src/index.ts")) {
    return "packages/okf/src/index.ts";
  }
  if (specifier.startsWith("@/") && importer.startsWith("apps/admin/")) {
    const aliasTarget = `apps/admin/src/${specifier.slice(2)}`;
    return resolveCandidate(aliasTarget, sourceByRelative);
  }
  if (!specifier.startsWith(".")) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  return resolveCandidate(base, sourceByRelative);
}

function resolveCandidate(base, sourceByRelative) {
  const candidates = [
    base,
    base.replace(/\.js$/u, ".ts"),
    base.replace(/\.js$/u, ".tsx"),
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`
  ];
  return candidates.find((candidate) => sourceByRelative.has(candidate)) ?? null;
}

function node(id, kind, details) {
  return { id, kind, ...details };
}

function edge(kind, from, to, suffix = "") {
  return { id: `${kind}:${from}:${to}:${suffix}`, kind, from, to };
}

function addNode(nodes, value) {
  if (!nodes.some((candidate) => candidate.id === value.id)) nodes.push(value);
}

function uniqueById(values) {
  return [...new Map(values.map((value) => [value.id, value])).values()].sort(byId);
}

function compactNode(value) {
  return { id: value.id, kind: value.kind, acceptedSetting: value.acceptedSetting ?? false };
}

function compactEdge(value) {
  return { id: value.id, kind: value.kind, from: value.from, to: value.to };
}

function compactFinding(value) {
  return {
    id: value.id,
    kind: value.kind,
    classification: value.classification,
    runtimeCaseRequired: value.runtimeCaseRequired,
    evidenceHash: value.evidenceHash
  };
}

function byId(left, right) {
  return left.id.localeCompare(right.id);
}

function hash(value) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

function relative(repositoryRoot, filePath) {
  return path.relative(repositoryRoot, filePath).split(path.sep).join("/");
}

function containsIdentifier(source, identifier) {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "u").test(source);
}
