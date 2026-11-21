"use client";
// Unstyled on purpose: the designer skins this after task E merges.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { SignedOutError } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";
import { goToNextStep } from "../next-step";

export default function SignInPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const { error: signInError } = await createClient().auth.signInWithPassword({
        email: String(form.get("email") ?? ""),
        password: String(form.get("password") ?? ""),
      });
      if (signInError) {
        setError("That email and password do not match. Please try again.");
        return;
      }
      try {
        await goToNextStep(router);
      } catch (e) {
        if (e instanceof SignedOutError) {
          // The API refused this session: do not keep it, or the proxy would loop.
          await createClient().auth.signOut({ scope: "local" });
          setError("We could not sign you in with this account. Please try again or contact support.");
          return;
        }
        setError("You are signed in, but we could not open RMS just now. Please try again.");
      }
    } catch {
      setError("We could not sign you in just now. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Sign in</h1>
      <form onSubmit={onSubmit}>
        <p>
          <label htmlFor="email">Email</label>
          <br />
          <input id="email" name="email" type="email" autoComplete="email" required />
        </p>
        <p>
          <label htmlFor="password">Password</label>
          <br />
          <input id="password" name="password" type="password" autoComplete="current-password" required />
        </p>
        {error ? <p role="alert">{error}</p> : null}
        <button type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <p>
        New to RMS? <Link href="/sign-up">Create an account</Link>
      </p>
    </main>
  );
}
