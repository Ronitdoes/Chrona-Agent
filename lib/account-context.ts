import { AsyncLocalStorage } from "node:async_hooks";
import type { Env } from "./env";
export type AccountContext = {
  userId: string;
  sessionId: string;
  config: Env;
  searchProvider: "tavily" | "exa";
  search?: typeof import("./tools/webSearch").webSearch;
};
export const accountContext = new AsyncLocalStorage<AccountContext>();
export async function providerConfig(): Promise<Env> {
  return accountContext.getStore()?.config ?? (await import("./env")).env;
}
