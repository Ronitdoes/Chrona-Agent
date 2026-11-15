import type { Metadata } from "next";
import { AppShell } from "../../components/app-shell";
import { AgentDemo } from "../../components/agent-demo";

export const metadata: Metadata = { title: "Component demo · Web Agent", robots: { index: false, follow: false } };

export default function DemoPage() {
  return <AppShell><AgentDemo /></AppShell>;
}
