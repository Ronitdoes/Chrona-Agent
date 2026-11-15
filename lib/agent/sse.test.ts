import { describe, expect, it, vi } from "vitest";
import { dataFrames } from "./sse";

function fragmented(text: string) {
  const bytes = new TextEncoder().encode(text);
  let index = 0;
  return new ReadableStream<Uint8Array>({ pull(controller) {
    if (index === bytes.length) controller.close();
    else controller.enqueue(bytes.slice(index, ++index));
  } });
}

describe("provider SSE data frames", () => {
  it("decodes fragmented UTF-8, CRLF, multiline data and a final unterminated frame", async () => {
    const stream = fragmented(': comment\r\ndata: μ\r\ndata: answer\r\n\r\ndata: final');
    expect(await Array.fromAsync(dataFrames(stream))).toEqual(["μ\nanswer", "final"]);
    expect(stream.locked).toBe(false);
  });

  it("cancels and releases the stream at the terminal marker", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode("data: answer\n\ndata: [DONE]\n\ndata: ignored\n\n"));
    }, cancel });
    expect(await Array.fromAsync(dataFrames(stream))).toEqual(["answer"]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("bounds an unfinished frame and releases its reader on failure", async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${"x".repeat(65_536)}`));
    } });
    await expect(Array.fromAsync(dataFrames(stream))).rejects.toThrow("exceeded its limit");
    expect(stream.locked).toBe(false);
  });
});
