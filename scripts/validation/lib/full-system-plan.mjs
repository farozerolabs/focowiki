import path from "node:path";

export const FULL_SYSTEM_EXTERNAL_APPROVAL_ENV =
  "FOCOWIKI_FULL_SYSTEM_ALLOW_CONFIGURED_EXTERNALS";
export const DEFAULT_FULL_SYSTEM_CHANGE_ID = "validate-focowiki-full-system-e2e";
export const DEFAULT_FULL_SYSTEM_REPORT_DIR =
  "ReferenceDocs/validate-focowiki-full-system-e2e";

export function readFullSystemConfig(command = "all", env = process.env) {
  if (!["plan", "baseline", "runtime", "all"].includes(command)) {
    throw new Error(`Unknown full-system validation command: ${command}`);
  }

  return {
    command,
    changeId: env.FOCOWIKI_FULL_SYSTEM_CHANGE_ID?.trim() || DEFAULT_FULL_SYSTEM_CHANGE_ID,
    reportDir: path.resolve(
      env.FOCOWIKI_FULL_SYSTEM_REPORT_DIR?.trim() || DEFAULT_FULL_SYSTEM_REPORT_DIR
    ),
    includeBrowser: readBoolean(env.FOCOWIKI_FULL_SYSTEM_INCLUDE_BROWSER, true),
    includeDocker: readBoolean(env.FOCOWIKI_FULL_SYSTEM_INCLUDE_DOCKER, true),
    includeSecurityAudit: readBoolean(
      env.FOCOWIKI_FULL_SYSTEM_INCLUDE_SECURITY_AUDIT,
      false
    ),
    allowConfiguredExternals: readBoolean(env[FULL_SYSTEM_EXTERNAL_APPROVAL_ENV], false),
    requireModel: readBoolean(env.FOCOWIKI_VALIDATION_REQUIRE_MODEL, true),
    sampleCount: readInteger(env.FOCOWIKI_VALIDATION_SAMPLE_COUNT, 120),
    contentSampleCount: readInteger(env.FOCOWIKI_VALIDATION_CONTENT_SAMPLE_COUNT, 30)
  };
}

export function buildFullSystemPlan(config) {
  const baseline = [
    nodeStep("coverage-manifest", ["scripts/validation/full-system-coverage.mjs"]),
    pnpmStep("workspace-typecheck", ["typecheck"]),
    pnpmStep("workspace-tests", ["test"]),
    pnpmStep("workspace-build", ["build"]),
    pnpmStep("validation-tests", ["test:validation"]),
    pnpmStep("openapi-contract", ["openapi:validate"]),
    pnpmStep("openapi-continuity", ["validate:openapi-continuity"]),
    pnpmStep("documentation-contract", ["docs:validate"]),
    pnpmStep("api-runtime-build", ["--filter", "@focowiki/api", "build:runtime"]),
    pnpmStep("admin-debug-output", ["validate:admin-build-debug-output"]),
    pnpmStep("no-local-paths", ["validate:no-local-paths"])
  ];

  if (config.includeSecurityAudit) {
    baseline.push(pnpmStep("security-audit", ["security:audit"]));
  }

  if (config.includeDocker) {
    baseline.push(
      pnpmStep("compose-example", ["compose:example:config"]),
      pnpmStep("compose-dev-example", ["compose:dev:example:config"]),
      pnpmStep("compose-local-example", ["compose:local:example:config"])
    );
  }

  const runtimeEnv = {
    FOCOWIKI_FULL_FLOW_CHANGE_ID: config.changeId,
    FOCOWIKI_VALIDATION_CHANGE_ID: config.changeId,
    FOCOWIKI_VALIDATION_REPORT_DIR: config.reportDir,
    FOCOWIKI_FULL_FLOW_REPORT_DIR: config.reportDir,
    FOCOWIKI_VALIDATION_SAMPLE_COUNT: String(config.sampleCount),
    FOCOWIKI_VALIDATION_BATCH_SAMPLE_COUNT: String(Math.max(config.sampleCount - 1, 1)),
    FOCOWIKI_VALIDATION_MIN_BATCH_FILES: String(Math.max(config.sampleCount - 1, 1)),
    FOCOWIKI_VALIDATION_CONTENT_SAMPLE_COUNT: String(config.contentSampleCount),
    FOCOWIKI_VALIDATION_REQUIRE_MODEL: config.requireModel ? "true" : "false",
    FOCOWIKI_FULL_FLOW_INCLUDE_BROWSER: "false",
    FOCOWIKI_FULL_FLOW_INCLUDE_REPOSITORY: "false",
    FOCOWIKI_FULL_FLOW_INCLUDE_DOCKER: "false"
  };
  const runtime = [
    externalNodeStep("full-runtime-flow", ["scripts/validation/full-flow-e2e.mjs", "large"], runtimeEnv),
    externalNodeStep(
      "generated-content-review",
      ["scripts/validation/generated-okf-file-inspection.mjs"],
      runtimeEnv
    ),
    ...(config.includeBrowser
      ? [
          externalNodeStep(
            "admin-ui-browser",
            ["scripts/validation/cleaned-markdown-browser.mjs", "large-browser"],
            runtimeEnv
          )
        ]
      : []),
    localDatabaseStep("large-nested-database")
  ];

  if (config.command === "plan") {
    return [...baseline, ...runtime];
  }
  if (config.command === "baseline") {
    return baseline;
  }
  if (config.command === "runtime") {
    return runtime;
  }
  return [...baseline, ...runtime];
}

function nodeStep(id, args, extraEnv = {}) {
  return createStep({ id, command: process.execPath, args, extraEnv });
}

function externalNodeStep(id, args, extraEnv) {
  return createStep({
    id,
    command: process.execPath,
    args,
    extraEnv,
    touchesConfiguredExternals: true
  });
}

function pnpmStep(id, args) {
  return createStep({ id, command: "pnpm", args, extraEnv: {} });
}

function localDatabaseStep(id) {
  return createStep({
    id,
    command: "pnpm",
    args: [
      "--filter",
      "@focowiki/api",
      "exec",
      "vitest",
      "run",
      "test/large-nested-scale.integration.test.ts"
    ],
    extraEnv: {
      FOCOWIKI_RUN_LARGE_NESTED_SCALE: "1",
      FOCOWIKI_TEST_DATABASE_URL: "<DATABASE_URL>"
    }
  });
}

function createStep(input) {
  const touchesConfiguredExternals = input.touchesConfiguredExternals ?? false;

  return {
    id: input.id,
    command: input.command,
    args: input.args,
    extraEnv: input.extraEnv,
    touchesConfiguredExternals,
    safeCommand: `${path.basename(input.command)} ${input.args.join(" ")}`,
    assertAllowed(config) {
      if (touchesConfiguredExternals && !config.allowConfiguredExternals) {
        throw new Error(
          `Step ${input.id} requires explicit approval through ${FULL_SYSTEM_EXTERNAL_APPROVAL_ENV}=true.`
        );
      }
    }
  };
}

function readBoolean(value, fallback) {
  if (value === undefined || value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function readInteger(value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("Full-system sample settings must be positive integers.");
  }
  return parsed;
}
