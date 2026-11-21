"use client";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button, FormLayout, Notice, TextField } from "@rms/ui";
import { supabaseBrowser } from "@/lib/supabase/client";

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
        setError("That email and password did not match. Please try again.");
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
