"use client";
// Unstyled on purpose: the designer skins this after task E merges.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { createClient } from "@/lib/supabase/client";

const MIN_PASSWORD = 8;

export default function SignUpPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    if (password !== String(form.get("confirm") ?? "")) {
      setError("The two passwords are not the same.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { data, error: signUpError } = await createClient().auth.signUp({
        email: String(form.get("email") ?? ""),
        password,
      });
      if (signUpError) {
        setError(
          signUpError.status === 422 || signUpError.code === "user_already_exists"
            ? "We could not create an account with that email. If you already have one, sign in instead."
            : "We could not create your account just now. Please try again.",
        );
        return;
      }
      if (!data.session) {
        setNotice("Check your email for a link to finish signing up.");
        return;
      }
      router.replace("/onboarding");
      router.refresh();
    } catch {
      setError("We could not create your account just now. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Create your account</h1>
      {notice ? (
        <p role="status">{notice}</p>
      ) : (
        <form onSubmit={onSubmit}>
          <p>
            <label htmlFor="email">Email</label>
            <br />
            <input id="email" name="email" type="email" autoComplete="email" required />
          </p>
          <p>
            <label htmlFor="password">Password</label>
            <br />
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={MIN_PASSWORD}
              required
              aria-describedby="password-hint"
            />
            <br />
            <span id="password-hint">At least {MIN_PASSWORD} characters.</span>
          </p>
          <p>
            <label htmlFor="confirm">Type the password again</label>
            <br />
            <input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={MIN_PASSWORD} required />
          </p>
          {error ? <p role="alert">{error}</p> : null}
          <button type="submit" disabled={busy}>
            {busy ? "Creating your account…" : "Create account"}
          </button>
        </form>
      )}
      <p>
        Already have an account? <Link href="/sign-in">Sign in</Link>
      </p>
    </main>
  );
}
