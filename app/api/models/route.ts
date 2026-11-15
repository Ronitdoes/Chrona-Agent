import { env } from "../../../lib/env";
import { modelCatalog } from "../../../lib/model-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET() {
  return Response.json(modelCatalog(env), { headers: { "Cache-Control": "private, no-store" } });
}
