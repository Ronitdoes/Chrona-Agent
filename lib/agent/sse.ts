// Decode provider SSE data without depending on a specific model transport.
export async function* dataFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frameData = (frame: string) => frame.split(/\r?\n/).filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let separator;
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const data = frameData(frame);
        if (data === "[DONE]") return;
        if (data) yield data;
      }
      if (buffer.length > 65_536) throw new Error("Model stream frame exceeded its limit");
      if (done) { const data = frameData(buffer); if (data && data !== "[DONE]") yield data; return; }
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
