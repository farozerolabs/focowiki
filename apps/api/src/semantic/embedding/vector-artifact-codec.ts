import { createHash } from "node:crypto";
import type { EmbeddingNormalization } from "../domain/contracts.js";

const MAGIC = Buffer.from("FWVEC001", "ascii");
const HEADER_BYTES = 16;

export type EncodedVectorArtifact = {
  bytes: Uint8Array;
  checksumSha256: string;
  byteCount: number;
  dimension: number;
  normalization: EmbeddingNormalization;
  artifactSchemaVersion: "focowiki-vector-artifact-v1";
};

export function encodeVectorArtifact(input: {
  vector: readonly number[];
  normalization: EmbeddingNormalization;
}): EncodedVectorArtifact {
  if (
    input.vector.length === 0
    || input.vector.length > 65_536
    || input.vector.some((value) => !Number.isFinite(value))
  ) throw new Error("Vector artifact input is invalid");
  const bytes = Buffer.allocUnsafe(HEADER_BYTES + input.vector.length * 4);
  MAGIC.copy(bytes, 0);
  bytes.writeUInt32LE(input.vector.length, 8);
  bytes.writeUInt8(input.normalization === "l2" ? 1 : 0, 12);
  bytes.fill(0, 13, HEADER_BYTES);
  input.vector.forEach((value, index) => bytes.writeFloatLE(value, HEADER_BYTES + index * 4));
  return {
    bytes,
    checksumSha256: createHash("sha256").update(bytes).digest("hex"),
    byteCount: bytes.byteLength,
    dimension: input.vector.length,
    normalization: input.normalization,
    artifactSchemaVersion: "focowiki-vector-artifact-v1"
  };
}

export function decodeVectorArtifact(input: {
  bytes: Uint8Array;
  checksumSha256: string;
  dimension: number;
  normalization: EmbeddingNormalization;
  maximumBytes: number;
}): readonly number[] {
  if (
    input.bytes.byteLength > input.maximumBytes
    || input.bytes.byteLength !== HEADER_BYTES + input.dimension * 4
    || createHash("sha256").update(input.bytes).digest("hex") !== input.checksumSha256
  ) throw new Error("Vector artifact integrity validation failed");
  const bytes = Buffer.from(input.bytes);
  if (
    !bytes.subarray(0, MAGIC.length).equals(MAGIC)
    || bytes.readUInt32LE(8) !== input.dimension
    || bytes.readUInt8(12) !== (input.normalization === "l2" ? 1 : 0)
    || bytes.subarray(13, HEADER_BYTES).some((value) => value !== 0)
  ) throw new Error("Vector artifact contract validation failed");
  const vector = Array.from({ length: input.dimension }, (_, index) =>
    bytes.readFloatLE(HEADER_BYTES + index * 4));
  if (vector.some((value) => !Number.isFinite(value))) {
    throw new Error("Vector artifact contains a non-finite value");
  }
  return vector;
}
