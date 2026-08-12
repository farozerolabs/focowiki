import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const TASKS = {
  scope: ["1.1", "1.2", "1.3", "1.4", "1.5"],
  ui: ["2.3", "11.1", "11.2", "11.3", "11.4", "11.5", "11.6", "24.2"],
  admin: ["2.2", "12.1", "12.2", "12.3", "12.4", "12.5", "24.3"],
  openapi: ["2.1", "13.1", "13.2", "13.3", "13.4", "13.5", "13.6"],
  config: ["2.4", "4.5", "8.1", "8.2", "8.3", "8.4", "8.5", "8.6"],
  persistence: ["2.5", "2.6", "14.1", "14.2", "14.3", "14.4", "14.5", "14.6", "14.7", "24.4"],
  authenticity: ["4.1", "4.2", "4.3", "4.4", "4.5", "4.6", "4.7"],
  generated: ["10.1", "10.2", "10.3", "10.4", "10.5", "10.6", "24.5", "24.6"],
  search: ["15.1", "15.2", "15.3", "15.4", "15.5", "15.6", "20.1", "20.2", "20.3", "20.4", "20.5", "20.6"],
  lifecycle: ["9.1", "9.2", "9.3", "9.4", "9.5", "9.6", "16.1", "16.2", "16.3", "16.4", "16.5", "16.6", "17.1", "17.2", "17.3", "17.4", "17.5"],
  docker: ["7.1", "7.2", "7.3", "7.4", "7.5", "7.6", "14.7"],
  security: ["18.1", "18.2", "18.3", "18.4", "18.5", "18.6"],
  recovery: ["19.1", "19.2", "19.3", "19.4", "19.5", "19.6"],
  performance: ["21.1", "21.2", "21.3", "21.4", "21.5", "21.6", "21.7", "22.1", "22.2", "22.3", "22.4", "22.5", "22.6"],
  final: ["23.1", "23.2", "23.3", "23.4", "23.5", "23.6", "24.1", "24.7", "25.1", "25.2", "25.3", "25.4", "25.5", "25.6", "25.7", "25.8"]
};

const groups = [
  {
    capabilities: [
      "admin-console-generation",
      "admin-credential-auth",
      "admin-pagination-controls",
      "admin-resource-deletion",
      "admin-resource-editing",
      "admin-runtime-settings",
      "admin-source-file-filtering"
    ],
    tasks: [...TASKS.ui, ...TASKS.admin, ...TASKS.config, ...TASKS.security]
  },
  {
    capabilities: [
      "developer-openapi",
      "developer-openapi-continuity-validation",
      "public-file-api",
      "public-openapi-key-management",
      "webhook-delivery"
    ],
    tasks: [...TASKS.openapi, ...TASKS.lifecycle, ...TASKS.security]
  },
  {
    capabilities: [
      "async-hard-delete",
      "knowledge-base-management",
      "knowledge-base-scope-deletion",
      "source-file-processing-queue",
      "source-file-task-deletion",
      "source-file-terminal-failure",
      "upload-task-lifecycle"
    ],
    tasks: [...TASKS.admin, ...TASKS.lifecycle, ...TASKS.persistence, ...TASKS.recovery]
  },
  {
    capabilities: [
      "bounded-storage-ownership",
      "breaking-storage-vnext-rebuild",
      "database-migration-maintenance-coordination",
      "incremental-release-projections",
      "large-batch-publication",
      "large-scale-generated-data-pipeline",
      "large-scale-read-models",
      "projection-repair-runtime",
      "storage-object-reconciliation"
    ],
    tasks: [...TASKS.persistence, ...TASKS.lifecycle, ...TASKS.recovery, ...TASKS.performance]
  },
  {
    capabilities: [
      "body-search-projection",
      "content-profile-generation",
      "file-first-graph-relations",
      "knowledge-base-index-maintenance",
      "lexical-rebuild-runtime",
      "meilisearch-search-runtime",
      "ranked-search-retrieval"
    ],
    tasks: [...TASKS.search, ...TASKS.generated, ...TASKS.persistence, ...TASKS.performance]
  },
  {
    capabilities: [
      "canonical-generated-text-identity",
      "domain-agnostic-markdown-ingestion",
      "domain-neutral-knowledge-processing-validation",
      "okf-bundle-generation",
      "okf-v0-2-trust-signals"
    ],
    tasks: [...TASKS.lifecycle, ...TASKS.generated, ...TASKS.search]
  },
  {
    capabilities: [
      "docker-compose-deployment",
      "durable-worker-runtime",
      "file-runtime-logging",
      "runtime-configuration",
      "runtime-plane-isolation"
    ],
    tasks: [...TASKS.config, ...TASKS.docker, ...TASKS.persistence, ...TASKS.recovery, ...TASKS.performance]
  },
  {
    capabilities: ["security-baseline"],
    tasks: [...TASKS.security, ...TASKS.authenticity, ...TASKS.final]
  },
  {
    capabilities: [
      "markdown-docs-deployment",
      "public-readme-documentation",
      "swagger-api-explorer"
    ],
    tasks: [...TASKS.openapi, "23.4", "24.3", "25.7"]
  },
  {
    capabilities: [
      "clean-architecture-full-system-validation",
      "cleaned-markdown-upload-validation",
      "compatibility-and-modularity",
      "durable-worker-e2e-validation",
      "full-flow-e2e-validation",
      "full-system-e2e-validation",
      "large-scale-full-system-e2e-validation",
      "large-scale-runtime-performance",
      "local-runtime-settings-e2e-validation"
    ],
    tasks: Object.values(TASKS).flat()
  }
];

export const COMPREHENSIVE_CONTRACT_TASKS = Object.freeze(
  Object.fromEntries(
    groups.flatMap((group) =>
      group.capabilities.map((capability) => [
        capability,
        [...new Set(group.tasks)].sort(compareTaskIds)
      ])
    )
  )
);

export const COMPREHENSIVE_OUT_OF_SCOPE_CONTRACTS = Object.freeze({
  "agent-backend-demo": "The separate demo product is outside this Focowiki-only release audit.",
  "agent-backend-demo-ddd-architecture": "The separate demo product is outside this Focowiki-only release audit.",
  "agent-openapi-exploration-validation": "Deployed demo and Agent validation is outside the local Focowiki runtime audit.",
  "cleaned-legal-e2e-validation": "The legal corpus is test input only; historical legal-specific validation is not a production contract.",
  "demo-agent-e2e-validation": "The separate demo product is outside this Focowiki-only release audit.",
  "demo-cli-package-channels": "CLI distribution is outside this Focowiki runtime audit.",
  "demo-cli-package-manager-artifacts": "CLI distribution is outside this Focowiki runtime audit.",
  "demo-cli-server-package-distribution": "CLI distribution is outside this Focowiki runtime audit.",
  "demo-dependency-security": "The separate demo repository is outside this Focowiki-only audit.",
  "demo-ghcr-docker-release": "Demo release distribution is outside this local audit.",
  "demo-production-upload-runner": "Production uploads are explicitly prohibited by this local audit.",
  "external-legal-data-okf-cleaning": "External data cleaning is outside Focowiki product behavior.",
  "github-container-ci-cd": "Remote release publication is outside this local release audit.",
  "large-legal-e2e-full-coverage": "The legal corpus is compatibility input only; domain-specific behavior is prohibited.",
  "local-cli-openapi-defect-classification": "The separate demo CLI is outside this Focowiki-only audit.",
  "local-demo-cli-e2e-validation": "The separate demo CLI is outside this Focowiki-only audit.",
  "local-full-stack-e2e-validation": "The demo and Skill integration stack is outside this Focowiki-only audit.",
  "online-cli-release-validation": "Production and online CLI mutation is outside this local audit.",
  "online-demo-openapi-validation": "The deployed demo environment is outside this local audit."
});

export function parseRequirementHeadings(content, capability) {
  const requirements = parseRequirements(content).map((requirement) => requirement.name);
  const duplicates = requirements.filter((value, index) => requirements.indexOf(value) !== index);

  if (duplicates.length > 0) {
    throw new Error(`Duplicate requirement heading in ${capability}: ${[...new Set(duplicates)].join(", ")}`);
  }
  return requirements;
}

export function buildRequirementTaskMatrix({ specFiles, taskIds }) {
  const knownTaskIds = new Set(taskIds);
  const matrix = [];

  for (const specFile of specFiles) {
    const mappedTaskIds = COMPREHENSIVE_CONTRACT_TASKS[specFile.capability];
    if (!mappedTaskIds) {
      throw new Error(`Unmapped contract capability: ${specFile.capability}`);
    }
    const unknownTaskIds = mappedTaskIds.filter((taskId) => !knownTaskIds.has(taskId));
    if (unknownTaskIds.length > 0) {
      throw new Error(`${specFile.capability} references unknown task: ${unknownTaskIds.join(", ")}`);
    }
    for (const requirement of parseRequirements(specFile.content)) {
      matrix.push({
        id: `${specFile.capability}::${requirement.name}`,
        capability: specFile.capability,
        requirement: requirement.name,
        scenarios: requirement.scenarios,
        requirementSha256: requirement.sha256,
        taskIds: [...mappedTaskIds]
      });
    }
  }

  if (new Set(matrix.map((row) => row.id)).size !== matrix.length) {
    throw new Error("Requirement-to-task matrix contains duplicate identities");
  }
  return matrix;
}

function parseRequirements(content) {
  const source = String(content);
  const matches = [...source.matchAll(/^### Requirement:\s+(.+)$/gmu)];

  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? source.length;
    const block = source.slice(start, end);
    return {
      name: match[1].trim(),
      scenarios: [...block.matchAll(/^#### Scenario:\s+(.+)$/gmu)].map((item) => item[1].trim()),
      sha256: createHash("sha256").update(block).digest("hex")
    };
  });
}

export function readCurrentRequirementTaskMatrix({ specRoot, tasksPath }) {
  const taskIds = [...fs.readFileSync(tasksPath, "utf8").matchAll(/^- \[[ x]\] (\d+\.\d+)\s/gmu)]
    .map((match) => match[1]);
  const capabilities = fs.readdirSync(specRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const unclassified = capabilities.filter(
    (capability) =>
      !COMPREHENSIVE_CONTRACT_TASKS[capability]
      && !COMPREHENSIVE_OUT_OF_SCOPE_CONTRACTS[capability]
  );

  if (unclassified.length > 0) {
    throw new Error(`Unclassified contract capability: ${unclassified.join(", ")}`);
  }

  const included = capabilities.filter((capability) => COMPREHENSIVE_CONTRACT_TASKS[capability]);
  const specFiles = included.map((capability) => ({
    capability,
    content: fs.readFileSync(path.join(specRoot, capability, "spec.md"), "utf8")
  }));

  return {
    included,
    excluded: capabilities
      .filter((capability) => COMPREHENSIVE_OUT_OF_SCOPE_CONTRACTS[capability])
      .map((capability) => ({
        capability,
        reason: COMPREHENSIVE_OUT_OF_SCOPE_CONTRACTS[capability]
      })),
    requirements: buildRequirementTaskMatrix({ specFiles, taskIds })
  };
}

function compareTaskIds(left, right) {
  const [leftGroup, leftItem] = left.split(".").map(Number);
  const [rightGroup, rightItem] = right.split(".").map(Number);
  return leftGroup - rightGroup || leftItem - rightItem;
}
