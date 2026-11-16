import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getStore } from "./store";
import { providerCredentials } from "./store/schema";
import { env, type Env } from "./env";
export const credentialProvider = z.enum([
  "anthropic",
  "gemini",
  "tavily",
  "exa",
]);
export type CredentialProvider = z.infer<typeof credentialProvider>;
export function encryptKey(
  key: string,
  userId: string,
  provider: string,
  secret: string,
): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(secret, "hex"),
    nonce,
  );
  cipher.setAAD(Buffer.from(JSON.stringify([userId, provider])));
  const encrypted = Buffer.concat([cipher.update(key, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString(
    "base64",
  );
}
export function decryptKey(
  value: string,
  userId: string,
  provider: string,
  secret: string,
): string {
  const data = Buffer.from(value, "base64");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(secret, "hex"),
    data.subarray(0, 12),
  );
  decipher.setAAD(Buffer.from(JSON.stringify([userId, provider])));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([
    decipher.update(data.subarray(28)),
    decipher.final(),
  ]).toString("utf8");
}
export async function credentialStatus(userId: string) {
  const { db } = await getStore();
  const rows = await db
    .select({ provider: providerCredentials.provider })
    .from(providerCredentials)
    .where(eq(providerCredentials.userId, userId));
  return Object.fromEntries(
    credentialProvider.options.map((provider) => [
      provider,
      rows.some((row) => row.provider === provider),
    ]),
  ) as Record<CredentialProvider, boolean>;
}
export async function accountConfig(userId: string): Promise<Env> {
  const { db } = await getStore();
  const rows = await db
    .select()
    .from(providerCredentials)
    .where(eq(providerCredentials.userId, userId));
  const keys = Object.fromEntries(
    rows.map((row) => [
      row.provider,
      decryptKey(
        row.encrypted,
        userId,
        row.provider,
        env.API_KEY_ENCRYPTION_KEY,
      ),
    ]),
  );
  return {
    ...env,
    ANTHROPIC_API_KEY: keys.anthropic ?? "",
    GEMINI_API_KEY: keys.gemini ?? "",
    TAVILY_API_KEY: keys.tavily ?? "",
    EXA_API_KEY: keys.exa ?? "",
    MODEL_PROVIDER: keys[env.MODEL_PROVIDER]
      ? env.MODEL_PROVIDER
      : keys.anthropic
        ? "anthropic"
        : "gemini",
  };
}
export async function saveCredential(
  userId: string,
  provider: CredentialProvider,
  key?: string,
) {
  const { db } = await getStore();
  if (key === undefined) {
    await db
      .delete(providerCredentials)
      .where(
        and(
          eq(providerCredentials.userId, userId),
          eq(providerCredentials.provider, provider),
        ),
      );
    return;
  }
  const encrypted = encryptKey(
    key,
    userId,
    provider,
    env.API_KEY_ENCRYPTION_KEY,
  );
  await db
    .insert(providerCredentials)
    .values({ userId, provider, encrypted })
    .onConflictDoUpdate({
      target: [providerCredentials.userId, providerCredentials.provider],
      set: { encrypted },
    });
}
