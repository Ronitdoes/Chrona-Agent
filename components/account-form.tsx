"use client";
import { useState } from "react";
import { authClient } from "../lib/auth-client";
export function AccountForm({ signup = false }: { signup?: boolean }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6">
      <h1 className="mb-6 text-2xl">
        {signup ? "Create your account" : "Sign in"}
      </h1>
      <form
        className="flex flex-col gap-4"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          const data = new FormData(event.currentTarget);
          const email = String(data.get("email"));
          const password = String(data.get("password"));
          try {
            const result = signup
              ? await authClient.signUp.email({
                  email,
                  password,
                  name: email.split("@")[0],
                })
              : await authClient.signIn.email({ email, password });
            if (result.error) {
              setError(
                "Unable to sign in or create this account. Check your details and try again.",
              );
              return;
            }
            const next = new URLSearchParams(window.location.search).get(
              "next",
            );
            window.location.assign(
              signup
                ? "/settings/api-keys"
                : next && /^\/chat\/[a-f0-9-]{36}$/i.test(next)
                  ? next
                  : "/",
            );
          } catch {
            setError("The account service is unavailable. Please try again.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Email
          <input
            className="mt-1 w-full rounded-lg border border-border bg-surface p-3"
            name="email"
            type="email"
            autoComplete="email"
            required
          />
        </label>
        <label>
          Password
          <input
            className="mt-1 w-full rounded-lg border border-border bg-surface p-3"
            name="password"
            type="password"
            minLength={12}
            maxLength={128}
            autoComplete={signup ? "new-password" : "current-password"}
            required
          />
        </label>
        {signup ? (
          <p className="text-sm text-muted">Use at least 12 characters.</p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm">
            {error}
          </p>
        ) : null}
        <button
          disabled={busy}
          className="rounded-lg bg-foreground p-3 text-background disabled:opacity-50"
        >
          {busy ? "Please wait…" : signup ? "Create account" : "Sign in"}
        </button>
        <a
          className="text-sm underline"
          href={signup ? "/sign-in" : "/sign-up"}
        >
          {signup ? "Already have an account? Sign in" : "Create an account"}
        </a>
      </form>
    </main>
  );
}
