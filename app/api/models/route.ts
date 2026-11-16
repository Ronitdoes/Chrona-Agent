import { privateApi } from "../../../lib/private-api";
import { accountConfig } from "../../../lib/credentials";
import { modelCatalog } from "../../../lib/model-config";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = privateApi(async (_request, userId) =>
  Response.json(modelCatalog(await accountConfig(userId))),
);
