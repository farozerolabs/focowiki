import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  compareSemanticPublicStructure,
  validateDomainNeutralSemanticSources,
  validateIncrementalSemanticTrace,
  validateSemanticArchitecture
} from "../lib/graphrag-change-gates.mjs";

test("semantic architecture rejects SDK, provider, database, S3, and presentation leakage", () => {
  const failures = validateSemanticArchitecture([
    { path: "apps/api/src/semantic/domain/model.ts", source: "import graphrag\nimport postgres from 'postgres'\nconst objectKey = 'x'" },
    { path: "apps/api/src/semantic/application/search.ts", source: "import { Client } from '@opensearch-project/opensearch'" },
    { path: "apps/api/src/semantic/presentation/routes.ts", source: "import { repo } from '../infrastructure/postgres-repository.js'" }
  ]);

  assert.deepEqual(failures.map((failure) => failure.code), [
    "GRAPHRAG_SDK_OUTSIDE_ADAPTER",
    "DATABASE_ACCESS_OUTSIDE_INFRASTRUCTURE",
    "S3_ACCESS_OUTSIDE_INFRASTRUCTURE",
    "SEARCH_PROVIDER_OUTSIDE_ADAPTER",
    "PRESENTATION_CROSSES_APPLICATION_BOUNDARY"
  ]);
});

test("semantic architecture allows owned contracts and isolated adapters", () => {
  assert.deepEqual(validateSemanticArchitecture([
    { path: "apps/api/python/graphrag_adapter/main.py", source: "from graphrag import api" },
    { path: "apps/api/src/semantic/domain/contracts.ts", source: "export type Entity = { label: string }" },
    { path: "apps/api/src/semantic/infrastructure/opensearch-vector-adapter.ts", source: "import { Client } from '@opensearch-project/opensearch'" }
  ]), []);
});

test("domain-neutral gate rejects domain production behavior but permits isolated fixtures", () => {
  assert.equal(validateDomainNeutralSemanticSources([
    { path: "apps/api/src/semantic/domain/entity-types.ts", source: "export const type = 'plaintiff'" }
  ])[0]?.code, "DOMAIN_SPECIFIC_PRODUCTION_BEHAVIOR");
  assert.deepEqual(validateDomainNeutralSemanticSources([
    { path: "apps/api/test/fixtures/semantic/legal-sample.ts", source: "export const type = 'plaintiff'" },
    { path: "apps/api/src/semantic/domain/entity-types.ts", source: "export const types = ['person', 'organization', 'place', 'concept', 'event']" }
  ]), []);
});

test("public structure gate protects paths, navigation, stable leaves, and source bodies", () => {
  const baseline = {
    generatedPaths: ["index.md", "pages/index.md", "pages/a.md"],
    navigationEdges: ["index.md->pages/index.md", "pages/index.md->pages/a.md"],
    sourcePagePaths: ["pages/a.md"],
    stableLeafPattern: "index-<stable-leaf-id>.md",
    sourceBodiesSha256: { "pages/a.md": "body-a" }
  };
  assert.deepEqual(compareSemanticPublicStructure(baseline, structuredClone(baseline)), []);
  const changed = structuredClone(baseline);
  changed.generatedPaths.push("entities/index.md");
  changed.navigationEdges = ["index.md->entities/index.md"];
  changed.sourcePagePaths = ["pages/renamed.md"];
  changed.stableLeafPattern = "page-<number>.md";
  changed.sourceBodiesSha256["pages/a.md"] = "rewritten";
  assert.deepEqual(compareSemanticPublicStructure(baseline, changed).map((failure) => failure.code), [
    "GENERATED_PATH_SET_CHANGED",
    "NAVIGATION_TOPOLOGY_CHANGED",
    "SOURCE_PAGE_PATHS_CHANGED",
    "STABLE_LEAF_SCHEME_CHANGED",
    "SOURCE_BODY_CHANGED"
  ]);
});

test("ordinary CRUD instrumentation rejects full and unrelated work", () => {
  const failures = validateIncrementalSemanticTrace({
    mode: "crud",
    operation: "replace-source-body",
    affectedSourceFilePublicIds: ["file-a"],
    affectedOwnerPublicIds: ["file-a", "entity-a"],
    graphReadScope: "knowledge_base",
    vectorWriteScope: "knowledge_base",
    sourceReads: ["file-a", "file-b"],
    modelCalls: ["file-b"],
    vectorWriteOwnerPublicIds: ["entity-b"]
  });
  assert.deepEqual(failures.map((failure) => failure.code), [
    "FULL_CORPUS_GRAPH_READ",
    "FULL_VECTOR_REWRITE",
    "UNRELATED_SOURCE_REREAD",
    "UNRELATED_MODEL_CALL",
    "UNRELATED_VECTOR_WRITE"
  ]);
  assert.deepEqual(validateIncrementalSemanticTrace({
    mode: "maintenance",
    operation: "explicit-adoption",
    graphReadScope: "knowledge_base",
    vectorWriteScope: "knowledge_base"
  }), []);
});

test("current semantic production surfaces satisfy architecture and domain-neutral gates", () => {
  const roots = ["apps/api/src/semantic", "apps/api/python/graphrag_adapter"];
  const files = roots.flatMap((root) => readSourceFiles(root));
  assert.deepEqual(validateSemanticArchitecture(files), []);
  assert.deepEqual(validateDomainNeutralSemanticSources(files), []);
});

function readSourceFiles(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) return readSourceFiles(filePath);
    if (!/\.(?:py|ts|tsx)$/u.test(entry.name)) return [];
    return [{ path: filePath, source: fs.readFileSync(filePath, "utf8") }];
  });
}
