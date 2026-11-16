import { notFound } from "next/navigation";
import { requireAccount } from "../../../../lib/private-page";
import { ownedConversation } from "../../../../lib/private-api";
export default async function ConversationPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const user = await requireAccount(`/chat/${sessionId}`);
  if (!(await ownedConversation(user.id, sessionId))) notFound();
  return null;
}
