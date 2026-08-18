import { describe, expect, it, vi } from "vitest";
import {
  createGraphRagFrameDecoder,
  encodeGraphRagFrame
} from "../src/semantic/graphrag/frame-codec.js";

describe("GraphRAG frame codec", () => {
  it("decodes fragmented and consecutive length-prefixed messages", () => {
    const values: unknown[] = [];
    const onError = vi.fn();
    const decoder = createGraphRagFrameDecoder({ onFrame: (value) => values.push(value), onError });
    const first = encodeGraphRagFrame({ id: "first" });
    const second = encodeGraphRagFrame({ id: "second" });
    decoder.push(first.subarray(0, 2));
    decoder.push(Buffer.concat([first.subarray(2), second]));
    expect(values).toEqual([{ id: "first" }, { id: "second" }]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("rejects oversized, malformed, and truncated frames safely", () => {
    const errors: Error[] = [];
    const decoder = createGraphRagFrameDecoder({
      maximumBytes: 8,
      onFrame: vi.fn(),
      onError: (error) => errors.push(error)
    });
    const header = Buffer.alloc(4);
    header.writeUInt32BE(9);
    decoder.push(header);
    expect(errors[0]?.message).toBe("Adapter frame length is outside its bound");

    const malformedErrors: Error[] = [];
    const malformed = createGraphRagFrameDecoder({
      onFrame: vi.fn(),
      onError: (error) => malformedErrors.push(error)
    });
    const payload = Buffer.from("secret-value", "utf8");
    const malformedHeader = Buffer.alloc(4);
    malformedHeader.writeUInt32BE(payload.length);
    malformed.push(Buffer.concat([malformedHeader, payload]));
    expect(malformedErrors[0]?.message).not.toContain("secret-value");

    const truncatedErrors: Error[] = [];
    const truncated = createGraphRagFrameDecoder({
      onFrame: vi.fn(),
      onError: (error) => truncatedErrors.push(error)
    });
    truncated.push(Buffer.from([0, 0, 0, 4, 123]));
    truncated.end();
    expect(truncatedErrors[0]?.message).toContain("declared length");
  });
});
