import { describe, expect, it } from "vitest";
import { JsonlDecoder } from "../src/runner/jsonl-decoder.js";

describe("JsonlDecoder", () => {
  it("uses LF framing and preserves Unicode separators inside JSON", () => {
    const records: unknown[] = [];
    const decoder = new JsonlDecoder((record) => records.push(record));
    const payload = `${JSON.stringify({ text: "one\u2028two" })}\n${JSON.stringify({ value: 2 })}\r\n`;
    const bytes = Buffer.from(payload);
    decoder.push(bytes.subarray(0, 8));
    decoder.push(bytes.subarray(8, 19));
    decoder.push(bytes.subarray(19));
    decoder.end();
    expect(records).toEqual([{ text: "one two" }, { value: 2 }]);
  });

  it("parses a final record without a newline", () => {
    const records: unknown[] = [];
    const decoder = new JsonlDecoder((record) => records.push(record));
    decoder.push('{"done":true}');
    decoder.end();
    expect(records).toEqual([{ done: true }]);
  });
});
