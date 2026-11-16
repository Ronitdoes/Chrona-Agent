import { Workspace } from "../../components/workspace";
import { headers } from "next/headers";
import { getAuth } from "../../lib/auth";
import { now } from "../../lib/clock";
export const dynamic = "force-dynamic";
export default async function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const login = await (
    await getAuth()
  ).api.getSession({ headers: await headers() });
  if (!login) return children;
  const user = login.user;
  const clock = now();
  return (
    <>
      <Workspace
        key={user.id}
        userId={user.id}
        initialClock={{ iso: clock.iso, tz: clock.tz }}
      />
      {children}
    </>
  );
}
