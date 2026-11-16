import { z } from "zod";
import { privateApi } from "../../../lib/private-api";
import {
  credentialProvider,
  credentialStatus,
  saveCredential,
} from "../../../lib/credentials";
import { readJson, jsonError } from "../../../lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = privateApi(async (_request, userId) =>
  Response.json(await credentialStatus(userId)),
);
export const PUT = privateApi(async (request, userId) => {
  const parsed = z
    .strictObject({
      provider: credentialProvider,
      key: z.string().trim().min(1).max(4096),
    })
    .safeParse(await readJson(request));
  if (!parsed.success)
    return jsonError("Supply a provider and an API key.", 400);
  await saveCredential(userId, parsed.data.provider, parsed.data.key);
  return Response.json(await credentialStatus(userId));
});
export const DELETE = privateApi(async (request, userId) => {
  const provider = credentialProvider.safeParse(
    new URL(request.url).searchParams.get("provider"),
  );
  if (!provider.success) return jsonError("Invalid provider.", 400);
  await saveCredential(userId, provider.data);
  return Response.json(await credentialStatus(userId));
});
