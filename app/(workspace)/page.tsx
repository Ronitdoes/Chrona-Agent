import { requireAccount } from "../../lib/private-page";
export default async function NewChatPage() {
  await requireAccount();
  return null;
}
