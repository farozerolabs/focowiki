import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compareSync } from "bcryptjs";
import { ensureBundledOpenSearchSecurityAssets } from
  "../src/infrastructure/opensearch/opensearch-security-assets.js";

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

describe("bundled OpenSearch security assets", () => {
  it("generates one complete private asset set and a runtime CA copy", () => {
    const fixture = createFixture();

    const result = ensureBundledOpenSearchSecurityAssets(fixture);

    expect(result).toMatchObject({ source: "generated" });
    for (const name of [
      "root-ca.pem",
      "node.pem",
      "node-key.pem",
      "admin.pem",
      "admin-key.pem",
      "manifest.json"
    ]) {
      expect(statSync(join(fixture.securityDirectory, "current", name)).isFile())
        .toBe(true);
    }
    expect(readFileSync(join(fixture.runtimeSecretDirectory, "opensearch-ca.pem")))
      .toEqual(readFileSync(
        join(fixture.securityDirectory, "current", "root-ca.pem")
      ));
    expect(statSync(fixture.securityDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(join(fixture.securityDirectory, "current")).mode & 0o777)
      .toBe(0o700);
    expect(statSync(join(
      fixture.securityDirectory,
      "current",
      "opensearch-security"
    )).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(
      fixture.securityDirectory,
      "current",
      "opensearch-security"
    )).sort()).toEqual([...SECURITY_CONFIG_FILES].sort());
    for (const name of SECURITY_CONFIG_FILES) {
      expect(statSync(join(
        fixture.securityDirectory,
        "current",
        "opensearch-security",
        name
      )).mode & 0o777).toBe(0o600);
    }
    expect(statSync(
      join(fixture.securityDirectory, "current", "node-key.pem")
    ).mode & 0o777).toBe(0o600);
    expect(statSync(
      join(fixture.securityDirectory, "current", "admin-key.pem")
    ).mode & 0o777).toBe(0o600);
    expect(statSync(
      join(fixture.securityDirectory, "current", "root-ca.pem")
    ).mode & 0o777).toBe(0o600);
    expect(statSync(
      join(fixture.securityDirectory, "current", "manifest.json")
    ).mode & 0o777).toBe(0o600);
    expect(readFileSync(
      join(fixture.securityDirectory, "current", "manifest.json"),
      "utf8"
    )).not.toMatch(/PRIVATE KEY|BEGIN CERTIFICATE|password|\$2[aby]\$/u);

    const configDirectory = join(
      fixture.securityDirectory,
      "current",
      "opensearch-security"
    );
    const internalUsers = readFileSync(
      join(configDirectory, "internal_users.yml"),
      "utf8"
    );
    expect(topLevelNames(internalUsers)).toEqual([
      "admin",
      "focowiki-runtime"
    ]);
    expect(internalUsers).not.toContain(fixture.adminPassword);
    const hashes = [...internalUsers.matchAll(/^  hash: "(\$2[aby]\$12\$[^"\n]+)"$/gmu)]
      .map((match) => match[1]);
    expect(hashes).toHaveLength(2);
    expect(compareSync(fixture.adminPassword, hashes[0] ?? "")).toBe(true);
    const runtimePassword = readFileSync(
      join(fixture.runtimeSecretDirectory, "opensearch-password"),
      "utf8"
    ).trim();
    expect(runtimePassword.length).toBeGreaterThanOrEqual(43);
    expect(compareSync(runtimePassword, hashes[1] ?? "")).toBe(true);
    expect(internalUsers).not.toContain(runtimePassword);
    expect(internalUsers).not.toMatch(
      /anomalyadmin|kibanaserver|kibanaro|logstash|readall|snapshotrestore/u
    );
    const roles = readFileSync(join(configDirectory, "roles.yml"), "utf8");
    expect(roles).toContain("focowiki-runtime_role:");
    expect(roles).toContain('- "focowiki_*"');
    expect(roles).toContain('- "cluster_monitor"');
    expect(roles).toContain('- "cluster_composite_ops"');
    expect(roles).toContain('- "crud"');
    expect(roles).not.toContain('- "*"');
    const mappings = readFileSync(
      join(configDirectory, "roles_mapping.yml"),
      "utf8"
    );
    expect(mappings).toContain("all_access:");
    expect(mappings).toContain('- "admin"');
    expect(mappings).toContain("focowiki-runtime_role:");
    expect(mappings).toContain('- "focowiki-runtime"');
    const current = join(fixture.securityDirectory, "current");
    expect(execFileSync("openssl", [
      "verify",
      "-CAfile",
      join(current, "root-ca.pem"),
      join(current, "node.pem"),
      join(current, "admin.pem")
    ], { encoding: "utf8" })).toMatch(/node\.pem: OK[\s\S]*admin\.pem: OK/u);
    const nodeCertificate = execFileSync("openssl", [
      "x509", "-in", join(current, "node.pem"), "-noout", "-text"
    ], { encoding: "utf8" });
    expect(nodeCertificate).toContain("DNS:opensearch");
    expect(nodeCertificate).toContain("DNS:localhost");
    expect(nodeCertificate).toContain("IP Address:127.0.0.1");
    expect(certificatePublicKey(join(current, "node.pem"))).toBe(
      privateKeyPublicKey(join(current, "node-key.pem"))
    );
    expect(certificatePublicKey(join(current, "admin.pem"))).toBe(
      privateKeyPublicKey(join(current, "admin-key.pem"))
    );
  });

  it("validates and reuses byte-identical assets on restart", () => {
    const fixture = createFixture();
    ensureBundledOpenSearchSecurityAssets(fixture);
    const before = assetFingerprint(fixture.securityDirectory);

    const result = ensureBundledOpenSearchSecurityAssets(fixture);

    expect(result.source).toBe("reused");
    expect(assetFingerprint(fixture.securityDirectory)).toBe(before);
  });

  it("rejects changed security identity inputs without replacing persisted state", () => {
    const fixture = createFixture();
    ensureBundledOpenSearchSecurityAssets(fixture);
    const before = assetFingerprint(fixture.securityDirectory);
    const runtimePasswordBefore = readFileSync(
      join(fixture.runtimeSecretDirectory, "opensearch-password")
    );

    for (const changed of [
      { adminPassword: "Changed-Admin-Password-2026!" },
      { indexPrefix: "another-prefix" },
      { runtimeUsername: "another-runtime" }
    ]) {
      expect(() => ensureBundledOpenSearchSecurityAssets({
        ...fixture,
        ...changed
      })).toThrow("OpenSearch security assets are incomplete or invalid");
      expect(assetFingerprint(fixture.securityDirectory)).toBe(before);
      expect(readFileSync(
        join(fixture.runtimeSecretDirectory, "opensearch-password")
      )).toEqual(runtimePasswordBefore);
    }
  });

  it("rejects partial state without silently replacing identity", () => {
    const fixture = createFixture();
    const current = join(fixture.securityDirectory, "current");
    mkdirSync(current, { recursive: true, mode: 0o700 });
    writeFileSync(join(current, "root-ca.pem"), "partial-secret-marker\n", {
      mode: 0o600
    });

    expect(() => ensureBundledOpenSearchSecurityAssets(fixture))
      .toThrow("OpenSearch security assets are incomplete or invalid");
    expect(readFileSync(join(current, "root-ca.pem"), "utf8"))
      .toBe("partial-secret-marker\n");
  });

  it("never publishes a current asset set after generation fails", () => {
    const fixture = createFixture();

    expect(() => ensureBundledOpenSearchSecurityAssets({
      ...fixture,
      opensslBinary: "missing-focowiki-openssl"
    })).toThrow("OpenSearch security assets are incomplete or invalid");
    expect(readdirSync(fixture.securityDirectory)).toEqual([]);
  });

  it("rejects corrupt, unsafe, or near-expiry assets", () => {
    const valid = createFixture();
    ensureBundledOpenSearchSecurityAssets(valid);
    const corrupt = cloneFixture(valid);
    const unsafe = cloneFixture(valid);
    const expiring = cloneFixture(valid);

    writeFileSync(
      join(corrupt.securityDirectory, "current", "node.pem"),
      "corrupt-secret-marker\n"
    );
    expect(() => ensureBundledOpenSearchSecurityAssets(corrupt))
      .toThrow("OpenSearch security assets are incomplete or invalid");
    try {
      ensureBundledOpenSearchSecurityAssets(corrupt);
    } catch (error) {
      expect(String(error)).not.toContain("corrupt-secret-marker");
    }

    chmodSync(join(unsafe.securityDirectory, "current", "node-key.pem"), 0o644);
    expect(() => ensureBundledOpenSearchSecurityAssets(unsafe))
      .toThrow("OpenSearch security assets are incomplete or invalid");

    expect(() => ensureBundledOpenSearchSecurityAssets({
      ...expiring,
      minimumValiditySeconds: 1_000 * 24 * 60 * 60
    })).toThrow("OpenSearch security assets are incomplete or invalid");
  });
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "focowiki-opensearch-security-"));
  return {
    securityDirectory: join(root, "security"),
    runtimeSecretDirectory: join(root, "runtime-secrets"),
    adminPassword: "FocoWiki-Test-Admin-Password-2026!",
    indexPrefix: "focowiki",
    runtimeUsername: "focowiki-runtime"
  };
}

function cloneFixture(source: ReturnType<typeof createFixture>) {
  const target = createFixture();
  cpSync(source.securityDirectory, target.securityDirectory, { recursive: true });
  cpSync(source.runtimeSecretDirectory, target.runtimeSecretDirectory, {
    recursive: true
  });
  return target;
}

function assetFingerprint(securityDirectory: string): string {
  const hash = createHash("sha256");
  for (const name of [
    "root-ca.pem",
    "node.pem",
    "node-key.pem",
    "admin.pem",
    "admin-key.pem",
    "manifest.json"
  ]) hash.update(readFileSync(join(securityDirectory, "current", name)));
  for (const name of SECURITY_CONFIG_FILES) hash.update(readFileSync(join(
    securityDirectory,
    "current",
    "opensearch-security",
    name
  )));
  return hash.digest("hex");
}

function topLevelNames(yaml: string): string[] {
  return [...yaml.matchAll(/^([a-z][a-z0-9_-]*):$/gmu)]
    .map((match) => match[1])
    .filter((name): name is string => typeof name === "string");
}

function certificatePublicKey(path: string): string {
  return execFileSync("openssl", ["x509", "-in", path, "-pubkey", "-noout"], {
    encoding: "utf8"
  }).trim();
}

function privateKeyPublicKey(path: string): string {
  return execFileSync("openssl", ["pkey", "-in", path, "-pubout"], {
    encoding: "utf8"
  }).trim();
}
