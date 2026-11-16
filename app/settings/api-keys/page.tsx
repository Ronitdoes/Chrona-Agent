import { requireAccount } from "../../../lib/private-page";
import { credentialStatus } from "../../../lib/credentials";
import { ApiKeySettings } from "../../../components/api-key-settings";
export const dynamic = "force-dynamic";
export default async function KeysPage() {
  const user = await requireAccount();
  return <ApiKeySettings initial={await credentialStatus(user.id)} />;
}
