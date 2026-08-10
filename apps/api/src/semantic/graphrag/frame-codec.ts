import { GraphRagAdapterError } from "./contracts.js";

export const DEFAULT_MAXIMUM_GRAPHRAG_FRAME_BYTES = 8 * 1024 * 1024;

export function encodeGraphRagFrame(
  value: unknown,
  maximumBytes = DEFAULT_MAXIMUM_GRAPHRAG_FRAME_BYTES
): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length === 0 || payload.length > maximumBytes) {
    throw new GraphRagAdapterError("FRAME_TOO_LARGE", "Adapter frame exceeds its bound");
  }
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export function createGraphRagFrameDecoder(input: {
  maximumBytes?: number;
  onFrame(value: unknown): void;
  onError(error: GraphRagAdapterError): void;
}): { push(chunk: Buffer): void; end(): void } {
  const maximumBytes = input.maximumBytes ?? DEFAULT_MAXIMUM_GRAPHRAG_FRAME_BYTES;
  let buffered = Buffer.alloc(0);
  let failed = false;
  function fail(code: string, message: string): void {
    if (failed) return;
    failed = true;
    buffered = Buffer.alloc(0);
    input.onError(new GraphRagAdapterError(code, message));
  }
  return {
    push(chunk) {
      if (failed || chunk.length === 0) return;
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4) {
        const length = buffered.readUInt32BE(0);
        if (length === 0 || length > maximumBytes) {
          fail("INVALID_FRAME_LENGTH", "Adapter frame length is outside its bound");
          return;
        }
        if (buffered.length < length + 4) return;
        const payload = buffered.subarray(4, length + 4);
        buffered = buffered.subarray(length + 4);
        try {
          input.onFrame(JSON.parse(payload.toString("utf8")));
        } catch {
          fail("INVALID_FRAME_PAYLOAD", "Adapter frame is not valid JSON");
          return;
        }
      }
    },
    end() {
      if (!failed && buffered.length > 0) {
        fail("TRUNCATED_FRAME", "Adapter frame ended before its declared length");
      }
    }
  };
}
