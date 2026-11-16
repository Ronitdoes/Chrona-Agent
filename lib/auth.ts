import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { getStore } from "./store";
import { env } from "./env";
async function createAuth() {
  const { db } = await getStore();
  return betterAuth({
    database: drizzleAdapter(db, { provider: "pg" }),
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    logger: { disabled: true },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    rateLimit: {
      enabled: true,
      storage: "memory",
      window: 60,
      max: 60,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 60, max: 5 },
      },
    },
    advanced: { useSecureCookies: process.env.NODE_ENV === "production" },
  });
}
let configured: ReturnType<typeof createAuth> | undefined;
export function getAuth() {
  return (configured ??= createAuth());
}
