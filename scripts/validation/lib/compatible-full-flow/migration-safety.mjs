const BLOCKED_PATTERNS = [
  {
    code: "DROP_TABLE",
    pattern: /\bdrop\s+table\b/i,
    message: "DROP TABLE is not allowed in compatible validation."
  },
  {
    code: "DROP_SCHEMA",
    pattern: /\bdrop\s+schema\b/i,
    message: "DROP SCHEMA is not allowed in compatible validation."
  },
  {
    code: "DROP_COLUMN",
    pattern: /\bdrop\s+column\b/i,
    message: "DROP COLUMN is not allowed in compatible validation."
  },
  {
    code: "TRUNCATE",
    pattern: /\btruncate\b/i,
    message: "TRUNCATE is not allowed in compatible validation."
  },
  {
    code: "BROAD_KNOWLEDGE_BASE_MUTATION",
    pattern: /\bupdate\s+focowiki\.knowledge_bases\s+set\s+active_release_id\s*=\s*null\b/i,
    message: "Broad active release reset is not allowed in compatible validation."
  },
  {
    code: "BROAD_DURABLE_DELETE",
    pattern:
      /\bdelete\s+from\s+focowiki\.(knowledge_bases|source_files|releases|bundle_files|bundle_tree_entries|publication_jobs|source_file_graph_nodes|source_file_graph_edges|source_file_graph_jobs|public_api_keys|webhook_subscriptions|webhook_deliveries)\b/i,
    message: "Broad durable table deletion is not allowed in compatible validation."
  }
];

export function findMigrationCompatibilityFindings(sqlText) {
  const findings = [];
  const statements = splitSqlStatements(sqlText);

  for (const statement of statements) {
    const normalized = normalizeSql(statement.text);

    if (!normalized) {
      continue;
    }

    for (const check of BLOCKED_PATTERNS) {
      if (check.pattern.test(normalized)) {
        findings.push({
          code: check.code,
          line: statement.line,
          message: check.message,
          snippet: normalized.slice(0, 180)
        });
      }
    }
  }

  return findings;
}

export function assertMigrationCompatibility(sqlText) {
  const findings = findMigrationCompatibilityFindings(sqlText);

  if (findings.length > 0) {
    throw new Error(
      `Migration compatibility check failed: ${findings
        .map((finding) => `${finding.code} at line ${finding.line}`)
        .join(", ")}`
    );
  }
}

function splitSqlStatements(sqlText) {
  const statements = [];
  let buffer = "";
  let line = 1;
  let statementLine = 1;
  let inDollarBlock = false;

  for (const rawLine of String(sqlText ?? "").split(/\r?\n/u)) {
    const trimmed = rawLine.trim();

    if (!buffer.trim()) {
      statementLine = line;
    }

    if (trimmed.includes("$$")) {
      inDollarBlock = !inDollarBlock;
    }

    buffer += `${rawLine}\n`;

    if (!inDollarBlock && trimmed.endsWith(";")) {
      statements.push({ line: statementLine, text: buffer });
      buffer = "";
    }

    line += 1;
  }

  if (buffer.trim()) {
    statements.push({ line: statementLine, text: buffer });
  }

  return statements;
}

function normalizeSql(statement) {
  return String(statement ?? "")
    .replace(/--.*$/gmu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}
