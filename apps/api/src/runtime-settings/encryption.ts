import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";

export function encryptRuntimeSecret(input: { value: string; secret: string }): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, deriveKey(input.secret), iv);
  const encrypted = Buffer.concat([cipher.update(input.value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url")
  ].join(":");
}

export function decryptRuntimeSecret(input: { value: string; secret: string }): string {
  const [version, ivValue, tagValue, encryptedValue] = input.value.split(":");

  if (version !== "v1" || !ivValue || !tagValue || !encryptedValue) {
    throw new Error("Unsupported encrypted runtime secret format");
  }

  const decipher = createDecipheriv(
    ALGORITHM,
    deriveKey(input.secret),
    Buffer.from(ivValue, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64url")),
    decipher.final()
  ]);

  return decrypted.toString("utf8");
}

export function fingerprintRuntimeSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}
