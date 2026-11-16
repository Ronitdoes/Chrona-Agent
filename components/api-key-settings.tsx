"use client";
import { useState } from "react";
import Link from "next/link";
import { authClient } from "../lib/auth-client";
const providers = {
  anthropic: "Anthropic",
  gemini: "Google AI Studio (Gemini)",
  tavily: "Tavily",
  exa: "Exa",
};
type Provider = keyof typeof providers;
export function ApiKeySettings({
  initial,
}: {
  initial: Record<Provider, boolean>;
}) {
  const [status, setStatus] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const ready =
    (status.anthropic || status.gemini) && (status.tavily || status.exa);
  async function update(provider: Provider, key?: string) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(
        `/api/credentials${key === undefined ? `?provider=${provider}` : ""}`,
        {
          method: key === undefined ? "DELETE" : "PUT",
          headers: { "Content-Type": "application/json" },
          ...(key !== undefined
            ? { body: JSON.stringify({ provider, key }) }
            : {}),
        },
      );
      if (!response.ok) throw new Error();
      setStatus(await response.json());
      setMessage(
        key === undefined
          ? "Key removed."
          : "Key saved. It will be checked when you use this provider.",
      );
    } catch {
      setMessage("The key could not be updated. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="mx-auto max-w-xl px-6 py-12">
      <h1 className="mb-3 text-2xl">API keys</h1>
      <p className="mb-8 text-sm text-muted">
        Connect one LLM provider and one search provider to start chatting.
        Requests use your provider accounts.
      </p>
      <div className="space-y-6">
        {(Object.keys(providers) as Provider[]).map((provider) => (
          <form
            key={provider}
            className="rounded-xl border border-border bg-surface p-4"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const key = String(new FormData(form).get("key"));
              form.reset();
              void update(provider, key);
            }}
          >
            <label className="block">
              {providers[provider]}
              <span className="ml-2 text-xs text-muted">
                {status[provider] ? "Configured" : "Add a key"}
              </span>
              <input
                name="key"
                aria-label={`${providers[provider]} API key`}
                type="password"
                autoComplete="off"
                required
                maxLength={4096}
                className="my-3 w-full rounded-lg border border-border bg-background p-3"
                placeholder={
                  status[provider] ? "Enter replacement key" : "Enter API key"
                }
              />
            </label>
            <button disabled={busy} className="mr-4 text-sm underline">
              {status[provider] ? "Replace" : "Save"}
            </button>
            {status[provider] ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void update(provider);
                }}
                className="text-sm underline"
              >
                Remove
              </button>
            ) : null}
          </form>
        ))}
      </div>
      <p role="status" className="my-4 text-sm">
        {message}
      </p>
      <Link className="underline" href="/">
        {ready ? "Continue to chat" : "View conversations"}
      </Link>
      <button
        className="ml-6 text-sm underline"
        onClick={async () => {
          await authClient.signOut();
          window.location.replace(
            new URL("/sign-in", window.location.origin).href,
          );
        }}
      >
        Sign out
      </button>
    </main>
  );
}
