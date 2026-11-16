import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "./auth";
export async function requireAccount(next = "/") {
  const login = await (
    await getAuth()
  ).api.getSession({ headers: await headers() });
  if (!login) redirect(`/sign-in?next=${encodeURIComponent(next)}`);
  return login.user;
}
