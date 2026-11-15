import { Workspace } from "../components/workspace";
import { now } from "../lib/clock";

export const dynamic = "force-dynamic";

export default function Home() {
  const clock = now();
  return <Workspace initialClock={{ iso: clock.iso, tz: clock.tz }} />;
}
