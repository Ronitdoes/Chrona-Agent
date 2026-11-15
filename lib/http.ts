import { z } from "zod";

export const timeZone = z.string().trim().min(1).max(100).refine((tz) => {
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; }
  catch { return false; }
}, "Unknown timezone");

export class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export async function readJson(request: Request, maxBytes = 32_768): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new RequestError(415, "Use Content-Type: application/json.");
  }
  if (Number(request.headers.get("content-length")) > maxBytes) throw new RequestError(413, "Request body is too large.");
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError(400, "A JSON request body is required.");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new RequestError(413, "Request body is too large."); }
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(400, "Invalid JSON request body.");
  } finally { reader.releaseLock(); }
}

export function jsonError(message: string, status: number, headers?: HeadersInit): Response {
  const response = Response.json({ error: { message } }, { status, headers });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
