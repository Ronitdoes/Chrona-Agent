import { randomUUID } from "node:crypto";
import { privateApi } from "../../../lib/private-api";
import { getStore } from "../../../lib/store";
import { conversations } from "../../../lib/store/schema";
export const runtime = "nodejs";
export const POST = privateApi(async (_request, userId) => {
  const id = randomUUID();
  await (await getStore()).db.insert(conversations).values({ id, userId });
  return Response.json({ id }, { status: 201 });
});
