import { after } from "next/server";
import { createChatHandler } from "../../../lib/chat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export const POST = createChatHandler({ after });
