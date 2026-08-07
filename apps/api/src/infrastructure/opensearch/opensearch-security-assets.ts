import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { compareSync, hashSync } from "bcryptjs";

const INVALID_ASSETS_MESSAGE =
  "OpenSearch security assets are incomplete or invalid";
const CURRENT_DIRECTORY = "current";
const SECURITY_CONFIG_DIRECTORY = "opensearch-security";
const RUNTIME_PASSWORD_FILE = "opensearch-password";
const CERTIFICATE_LIFETIME_DAYS = 825;
const DEFAULT_MINIMUM_VALIDITY_SECONDS = 30 * 24 * 60 * 60;
const BCRYPT_ROUNDS = 12;
const EXPECTED_ROOT_ENTRIES = [
  "admin-key.pem",
  "admin.pem",
  "manifest.json",
  "node-key.pem",
  "node.pem",
  SECURITY_CONFIG_DIRECTORY,
  "root-ca.pem"
] as const;
const SECURITY_CONFIG_FILES = [
  "action_groups.yml",
  "allowlist.yml",
  "audit.yml",
  "config.yml",
  "internal_users.yml",
  "nodes_dn.yml",
  "roles.yml",
  "roles_mapping.yml",
  "tenants.yml"
] as const;
const NODE_SUBJECT = "CN=opensearch";
const ADMIN_SUBJECT = "CN=focowiki-opensearch-admin";
const NODE_SANS = ["DNS:opensearch", "DNS:localhost", "IP:127.0.0.1"];

type SecurityAssetInput = {
  securityDirectory: string;
  runtimeSecretDirectory: string;
  adminPassword: string;
  indexPrefix: string;
  runtimeUsername: string;
  minimumValiditySeconds?: number;
  opensslBinary?: string;
};

export function ensureBundledOpenSearchSecurityAssets(
  input: SecurityAssetInput
): { source: "generated" | "reused"; currentDirectory: string } {
  let pendingDirectory: string | null = null;
  try {
    const validated = validateInput(input);
    const openssl = input.opensslBinary ?? "openssl";
    preparePrivateDirectory(input.securityDirectory);
    preparePrivateDirectory(input.runtimeSecretDirectory);
    const currentDirectory = join(input.securityDirectory, CURRENT_DIRECTORY);
    const runtimePasswordPath = join(
      input.runtimeSecretDirectory,
      RUNTIME_PASSWORD_FILE
    );
    let source: "generated" | "reused";
    let runtimePassword: string;

    if (existsSync(currentDirectory)) {
      runtimePassword = readRuntimePassword(runtimePasswordPath);
      source = "reused";
    } else {
      if (
        readdirSync(input.securityDirectory).length > 0
        || existsSync(runtimePasswordPath)
      ) fail();
      runtimePassword = randomBytes(48).toString("base64url");
      pendingDirectory = join(
        input.securityDirectory,
        `.pending-${randomUUID()}`
      );
      generateAssets({
        directory: pendingDirectory,
        openssl,
        ...validated,
        runtimePassword
      });
      validateAssetDirectory({
        directory: pendingDirectory,
        openssl,
        ...validated,
        runtimePassword
      });
      persistRuntimePassword(runtimePasswordPath, runtimePassword);
      renameSync(pendingDirectory, currentDirectory);
      pendingDirectory = null;
      source = "generated";
    }

    validateSecurityRoot(input.securityDirectory);
    validateAssetDirectory({
      directory: currentDirectory,
      openssl,
      ...validated,
      runtimePassword
    });
    publishRuntimeCa({
      source: join(currentDirectory, "root-ca.pem"),
      runtimeSecretDirectory: input.runtimeSecretDirectory
    });
    return { source, currentDirectory };
  } catch {
    if (pendingDirectory) {
      rmSync(pendingDirectory, { force: true, recursive: true });
    }
    throw new Error(INVALID_ASSETS_MESSAGE);
  }
}

function validateInput(input: SecurityAssetInput): {
  adminPassword: string;
  indexPrefix: string;
  runtimeUsername: string;
  minimumValiditySeconds: number;
} {
  if (
    !isAbsolute(input.securityDirectory)
    || !isAbsolute(input.runtimeSecretDirectory)
    || input.securityDirectory === input.runtimeSecretDirectory
  ) fail();
  validatePassword(input.adminPassword, 12);
  const indexPrefix = validateIdentifier(input.indexPrefix, 80);
  const runtimeUsername = validateIdentifier(input.runtimeUsername, 200);
  const minimumValiditySeconds =
    input.minimumValiditySeconds ?? DEFAULT_MINIMUM_VALIDITY_SECONDS;
  if (
    !Number.isSafeInteger(minimumValiditySeconds)
    || minimumValiditySeconds < 1
    || minimumValiditySeconds > 10_000 * 24 * 60 * 60
  ) fail();
  return {
    adminPassword: input.adminPassword,
    indexPrefix,
    runtimeUsername,
    minimumValiditySeconds
  };
}

function validateIdentifier(value: string, maximum: number): string {
  const normalized = value.trim();
  if (
    normalized.length > maximum
    || !/^[a-z0-9][a-z0-9_-]*$/u.test(normalized)
  ) fail();
  return normalized;
}

function validatePassword(value: string, minimumLength: number): void {
  if (
    value.length < minimumLength
    || value.length > 4_096
    || /[\r\n]/u.test(value)
  ) fail();
}

function preparePrivateDirectory(directory: string): void {
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  chmodSync(directory, 0o700);
  assertDirectory(directory, 0o700);
}

function validateSecurityRoot(directory: string): void {
  assertDirectory(directory, 0o700);
  if (!sameEntries(readdirSync(directory), [CURRENT_DIRECTORY])) fail();
}

function generateAssets(input: {
  directory: string;
  openssl: string;
  adminPassword: string;
  runtimePassword: string;
  indexPrefix: string;
  runtimeUsername: string;
}): void {
  mkdirSync(input.directory, { mode: 0o700 });
  writeFileSync(join(input.directory, "node.ext"), [
    "basicConstraints=critical,CA:FALSE",
    "keyUsage=critical,digitalSignature,keyEncipherment",
    "extendedKeyUsage=serverAuth,clientAuth",
    `subjectAltName=${NODE_SANS.join(",")}`,
    ""
  ].join("\n"), { mode: 0o600 });
  writeFileSync(join(input.directory, "admin.ext"), [
    "basicConstraints=critical,CA:FALSE",
    "keyUsage=critical,digitalSignature,keyEncipherment",
    "extendedKeyUsage=clientAuth",
    ""
  ].join("\n"), { mode: 0o600 });

  runOpenSsl(input.openssl, [
    "genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:3072",
    "-out", "root-ca-key.pem"
  ], input.directory);
  runOpenSsl(input.openssl, [
    "req", "-x509", "-new", "-sha256", "-days",
    String(CERTIFICATE_LIFETIME_DAYS), "-key", "root-ca-key.pem",
    "-subj", "/CN=FocoWiki OpenSearch Root CA", "-out", "root-ca.pem"
  ], input.directory);
  generateSignedCertificate({
    directory: input.directory,
    openssl: input.openssl,
    name: "node",
    subject: "/CN=opensearch",
    extensionFile: "node.ext",
    createSerial: true
  });
  generateSignedCertificate({
    directory: input.directory,
    openssl: input.openssl,
    name: "admin",
    subject: "/CN=focowiki-opensearch-admin",
    extensionFile: "admin.ext",
    createSerial: false
  });

  const configDirectory = join(input.directory, SECURITY_CONFIG_DIRECTORY);
  mkdirSync(configDirectory, { mode: 0o700 });
  const adminHash = hashSync(input.adminPassword, BCRYPT_ROUNDS);
  const runtimeHash = hashSync(input.runtimePassword, BCRYPT_ROUNDS);
  const configuration = createSecurityConfiguration({
    adminHash,
    runtimeHash,
    indexPrefix: input.indexPrefix,
    runtimeUsername: input.runtimeUsername
  });
  for (const [name, contents] of Object.entries(configuration)) {
    writeFileSync(join(configDirectory, name), contents, { mode: 0o600 });
  }

  writeFileSync(join(input.directory, "manifest.json"), `${JSON.stringify({
    formatVersion: 2,
    generatedAt: new Date().toISOString(),
    certificateLifetimeDays: CERTIFICATE_LIFETIME_DAYS,
    nodeSubject: NODE_SUBJECT,
    adminSubject: ADMIN_SUBJECT,
    nodeSans: NODE_SANS,
    indexPrefix: input.indexPrefix,
    runtimeUsername: input.runtimeUsername,
    rootEntries: EXPECTED_ROOT_ENTRIES,
    securityConfigFiles: SECURITY_CONFIG_FILES
  }, null, 2)}\n`, { mode: 0o600 });

  for (const name of [
    "root-ca-key.pem",
    "root-ca.srl",
    "node.csr",
    "node.ext",
    "admin.csr",
    "admin.ext"
  ]) rmSync(join(input.directory, name), { force: true });
  enforcePrivateModes(input.directory);
}

function createSecurityConfiguration(input: {
  adminHash: string;
  runtimeHash: string;
  indexPrefix: string;
  runtimeUsername: string;
}): Record<(typeof SECURITY_CONFIG_FILES)[number], string> {
  const roleName = `${input.runtimeUsername}_role`;
  return {
    "action_groups.yml": `_meta:\n  type: "actiongroups"\n  config_version: 2\n`,
    "allowlist.yml": `_meta:\n  type: "allowlist"\n  config_version: 2\nconfig:\n  enabled: false\n  requests: {}\n`,
    "audit.yml": `_meta:\n  type: "audit"\n  config_version: 2\nconfig:\n  enabled: false\n`,
    "config.yml": `_meta:\n  type: "config"\n  config_version: 2\nconfig:\n  dynamic:\n    http:\n      anonymous_auth_enabled: false\n      xff:\n        enabled: false\n    authc:\n      basic_internal_auth_domain:\n        description: "Authenticate with the internal user database"\n        http_enabled: true\n        transport_enabled: true\n        order: 0\n        http_authenticator:\n          type: basic\n          challenge: true\n        authentication_backend:\n          type: intern\n    authz: {}\n`,
    "internal_users.yml": `_meta:\n  type: "internalusers"\n  config_version: 2\nadmin:\n  hash: "${input.adminHash}"\n  reserved: true\n  backend_roles:\n    - "admin"\n  description: "FocoWiki deployment administrator"\n${input.runtimeUsername}:\n  hash: "${input.runtimeHash}"\n  reserved: true\n  opendistro_security_roles:\n    - "${roleName}"\n  description: "FocoWiki search runtime"\n`,
    "nodes_dn.yml": `_meta:\n  type: "nodesdn"\n  config_version: 2\n`,
    "roles.yml": `_meta:\n  type: "roles"\n  config_version: 2\n${roleName}:\n  reserved: true\n  cluster_permissions:\n    - "cluster_monitor"\n    - "cluster_composite_ops"\n  index_permissions:\n    - index_patterns:\n        - "${input.indexPrefix}_*"\n      allowed_actions:\n        - "crud"\n        - "create_index"\n        - "manage"\n        - "indices_monitor"\n  tenant_permissions: []\n`,
    "roles_mapping.yml": `_meta:\n  type: "rolesmapping"\n  config_version: 2\nall_access:\n  reserved: true\n  backend_roles:\n    - "admin"\n${roleName}:\n  reserved: true\n  users:\n    - "${input.runtimeUsername}"\n`,
    "tenants.yml": `_meta:\n  type: "tenants"\n  config_version: 2\n`
  };
}

function enforcePrivateModes(directory: string): void {
  for (const name of EXPECTED_ROOT_ENTRIES) {
    const path = join(directory, name);
    if (name === SECURITY_CONFIG_DIRECTORY) {
      chmodSync(path, 0o700);
      for (const configName of SECURITY_CONFIG_FILES) {
        chmodSync(join(path, configName), 0o600);
      }
    } else {
      chmodSync(path, 0o600);
    }
  }
  chmodSync(directory, 0o700);
}

function generateSignedCertificate(input: {
  directory: string;
  openssl: string;
  name: "node" | "admin";
  subject: string;
  extensionFile: string;
  createSerial: boolean;
}): void {
  runOpenSsl(input.openssl, [
    "genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:3072",
    "-out", `${input.name}-key.pem`
  ], input.directory);
  runOpenSsl(input.openssl, [
    "req", "-new", "-sha256", "-key", `${input.name}-key.pem`,
    "-subj", input.subject, "-out", `${input.name}.csr`
  ], input.directory);
  runOpenSsl(input.openssl, [
    "x509", "-req", "-sha256", "-days", String(CERTIFICATE_LIFETIME_DAYS),
    "-in", `${input.name}.csr`, "-CA", "root-ca.pem", "-CAkey",
    "root-ca-key.pem", input.createSerial ? "-CAcreateserial" : "-CAserial",
    ...(input.createSerial ? [] : ["root-ca.srl"]),
    "-extfile", input.extensionFile, "-out", `${input.name}.pem`
  ], input.directory);
}

function validateAssetDirectory(input: {
  directory: string;
  openssl: string;
  minimumValiditySeconds: number;
  adminPassword: string;
  runtimePassword: string;
  indexPrefix: string;
  runtimeUsername: string;
}): void {
  assertDirectory(input.directory, 0o700);
  if (!sameEntries(readdirSync(input.directory), EXPECTED_ROOT_ENTRIES)) fail();
  for (const name of EXPECTED_ROOT_ENTRIES) {
    if (name === SECURITY_CONFIG_DIRECTORY) continue;
    assertFile(join(input.directory, name), 0o600);
  }
  const configDirectory = join(input.directory, SECURITY_CONFIG_DIRECTORY);
  assertDirectory(configDirectory, 0o700);
  if (!sameEntries(readdirSync(configDirectory), SECURITY_CONFIG_FILES)) fail();
  for (const name of SECURITY_CONFIG_FILES) {
    assertFile(join(configDirectory, name), 0o600);
  }
  validateManifest(join(input.directory, "manifest.json"), input);
  validateSecurityConfiguration(configDirectory, input);

  const rootCa = join(input.directory, "root-ca.pem");
  const nodeCertificate = join(input.directory, "node.pem");
  const adminCertificate = join(input.directory, "admin.pem");
  runOpenSsl(input.openssl, ["verify", "-CAfile", rootCa, rootCa]);
  runOpenSsl(input.openssl, [
    "verify", "-CAfile", rootCa, nodeCertificate, adminCertificate
  ]);
  for (const certificate of [rootCa, nodeCertificate, adminCertificate]) {
    runOpenSsl(input.openssl, [
      "x509", "-in", certificate, "-checkend",
      String(input.minimumValiditySeconds), "-noout"
    ]);
  }
  assertMatchingKey(input.openssl, nodeCertificate, join(input.directory, "node-key.pem"));
  assertMatchingKey(
    input.openssl,
    adminCertificate,
    join(input.directory, "admin-key.pem")
  );
  const nodeText = runOpenSsl(input.openssl, [
    "x509", "-in", nodeCertificate, "-noout", "-text"
  ]);
  for (const expected of [
    "DNS:opensearch",
    "DNS:localhost",
    "IP Address:127.0.0.1",
    "TLS Web Server Authentication",
    "TLS Web Client Authentication"
  ]) if (!nodeText.includes(expected)) fail();
}

function validateManifest(
  path: string,
  input: { indexPrefix: string; runtimeUsername: string }
): void {
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (
    manifest.formatVersion !== 2
    || manifest.certificateLifetimeDays !== CERTIFICATE_LIFETIME_DAYS
    || manifest.nodeSubject !== NODE_SUBJECT
    || manifest.adminSubject !== ADMIN_SUBJECT
    || manifest.indexPrefix !== input.indexPrefix
    || manifest.runtimeUsername !== input.runtimeUsername
    || !sameEntries(asStringArray(manifest.nodeSans), NODE_SANS)
    || !sameEntries(asStringArray(manifest.rootEntries), EXPECTED_ROOT_ENTRIES)
    || !sameEntries(
      asStringArray(manifest.securityConfigFiles),
      SECURITY_CONFIG_FILES
    )
    || typeof manifest.generatedAt !== "string"
    || Number.isNaN(Date.parse(manifest.generatedAt))
  ) fail();
}

function validateSecurityConfiguration(
  directory: string,
  input: {
    adminPassword: string;
    runtimePassword: string;
    indexPrefix: string;
    runtimeUsername: string;
  }
): void {
  const internalUsers = readFileSync(join(directory, "internal_users.yml"), "utf8");
  const hashMatches = [
    ...internalUsers.matchAll(/^  hash: "(\$2[aby]\$12\$[^"\n]+)"$/gmu)
  ];
  if (
    hashMatches.length !== 2
    || !compareSync(input.adminPassword, hashMatches[0]?.[1] ?? "")
    || !compareSync(input.runtimePassword, hashMatches[1]?.[1] ?? "")
  ) fail();
  const expected = createSecurityConfiguration({
    adminHash: hashMatches[0]?.[1] ?? "",
    runtimeHash: hashMatches[1]?.[1] ?? "",
    indexPrefix: input.indexPrefix,
    runtimeUsername: input.runtimeUsername
  });
  for (const [name, contents] of Object.entries(expected)) {
    if (readFileSync(join(directory, name), "utf8") !== contents) fail();
  }
}

function assertMatchingKey(
  openssl: string,
  certificate: string,
  privateKey: string
): void {
  const certificateKey = runOpenSsl(openssl, [
    "x509", "-in", certificate, "-pubkey", "-noout"
  ]).trim();
  const privateKeyPublic = runOpenSsl(openssl, [
    "pkey", "-in", privateKey, "-pubout"
  ]).trim();
  if (certificateKey !== privateKeyPublic) fail();
}

function readRuntimePassword(path: string): string {
  assertFile(path, 0o600);
  const password = readFileSync(path, "utf8").trim();
  validatePassword(password, 43);
  return password;
}

function persistRuntimePassword(path: string, password: string): void {
  validatePassword(password, 43);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${password}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function publishRuntimeCa(input: {
  source: string;
  runtimeSecretDirectory: string;
}): void {
  const target = join(input.runtimeSecretDirectory, "opensearch-ca.pem");
  const sourceContents = readFileSync(input.source);
  if (existsSync(target) && readFileSync(target).equals(sourceContents)) {
    chmodSync(target, 0o600);
    return;
  }
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, sourceContents, { flag: "wx", mode: 0o600 });
    renameSync(temporary, target);
    chmodSync(target, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function assertDirectory(path: string, mode: number): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== mode) {
    fail();
  }
}

function assertFile(path: string, mode: number): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== mode) {
    fail();
  }
}

function sameEntries(actual: readonly string[], expected: readonly string[]): boolean {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : [];
}

function runOpenSsl(openssl: string, args: string[], cwd?: string): string {
  return execFileSync(openssl, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function fail(): never {
  throw new Error(INVALID_ASSETS_MESSAGE);
}
