"use client";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button, FormLayout, Notice, TextField } from "@rms/ui";
import { supabaseBrowser } from "@/lib/supabase/client";

/**
 * The sign-in service refuses with status 429 (code "over_request_rate_limit") after too many
 * tries from one place in a few minutes. That is not a wrong password, so it gets its own words.
 */
const tooManyTries = (e: { status?: number | undefined; code?: string | undefined }): boolean => e.status === 429 || (e.code ?? "").endsWith("rate_limit");
const TOO_MANY_TRIES = "Too many tries. Wait a minute and try again.";

export default function SignInPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const { error: signInError } = await supabaseBrowser().auth.signInWithPassword({
        email: String(form.get("email") ?? ""),
        password: String(form.get("password") ?? ""),
      });
      if (signInError) {
        setError(tooManyTries(signInError) ? TOO_MANY_TRIES : "That email and password did not match. Please try again.");
        return;
      }
      router.replace("/");
      router.refresh();
    } catch {
      setError("Sign-in is not available right now. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormLayout
      title="Maintainer sign-in"
      titleLevel={1}
      onSubmit={onSubmit}
      message={error ? <Notice kind="problem">{error}</Notice> : null}
      actions={
        <Button type="submit" variant="primary" size="l" block busy={busy}>
          {busy ? "Signing in..." : "Sign in"}
        </Button>
      }
    >
      <TextField id="email" name="email" type="email" label="Email" autoComplete="username" required />
      <TextField id="password" name="password" type="password" label="Password" autoComplete="current-password" required />
    </FormLayout>
  );
}
