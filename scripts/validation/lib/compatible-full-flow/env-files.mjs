import fs from "node:fs";
import path from "node:path";

export function parseEnvKeys(text) {
  const keys = [];
  const seen = new Set();

  for (const rawLine of String(text ?? "").split(/\r?\n/u)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);

    if (!match) {
      continue;
    }

    const key = match[1];

    if (!seen.has(key)) {
      keys.push(key);
      seen.add(key);
    }
  }

  return keys;
}

export function compareEnvTemplateFields({
  envPath = ".env",
  templatePath = ".env.example",
  cwd = process.cwd()
} = {}) {
  const absoluteEnvPath = path.resolve(cwd, envPath);
  const absoluteTemplatePath = path.resolve(cwd, templatePath);

  if (!fs.existsSync(absoluteTemplatePath)) {
    throw new Error(`Environment template not found: ${templatePath}`);
  }

  if (!fs.existsSync(absoluteEnvPath)) {
    throw new Error(`Environment file not found: ${envPath}`);
  }

  const templateKeys = parseEnvKeys(fs.readFileSync(absoluteTemplatePath, "utf8"));
  const envKeys = parseEnvKeys(fs.readFileSync(absoluteEnvPath, "utf8"));
  const templateSet = new Set(templateKeys);
  const envSet = new Set(envKeys);

  return {
    templatePath,
    envPath,
    templateKeys,
    envKeys,
    missingInEnv: templateKeys.filter((key) => !envSet.has(key)),
    extraInEnv: envKeys.filter((key) => !templateSet.has(key)),
    orderMismatch: envKeys.filter((key, index) => templateKeys[index] !== key && templateSet.has(key))
  };
}

export function assertEnvTemplateFieldsAligned(comparison) {
  const problems = [];

  if (comparison.missingInEnv.length > 0) {
    problems.push(`missing in .env: ${comparison.missingInEnv.join(", ")}`);
  }

  if (comparison.extraInEnv.length > 0) {
    problems.push(`extra in .env: ${comparison.extraInEnv.join(", ")}`);
  }

  if (problems.length > 0) {
    throw new Error(`Environment fields are not aligned with template: ${problems.join("; ")}`);
  }
}
