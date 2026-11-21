"use client";
// Skinned with @rms/ui only. The sign-in logic is task A's and is unchanged.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button, Canvas, FormLayout, Logo, Notice, Text, TextField } from "@rms/ui";
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
    <Canvas narrow header={<Logo />}>
      <FormLayout
        title="Sign in"
        titleLevel={1}
        onSubmit={onSubmit}
        message={error ? <Notice kind="problem">{error}</Notice> : null}
        actions={
          <Button type="submit" variant="primary" size="l" block busy={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        }
      >
        <TextField id="email" name="email" type="email" label="Email" autoComplete="email" required />
        <TextField id="password" name="password" type="password" label="Password" autoComplete="current-password" required />
      </FormLayout>
      <Text>
        New to RMS? <Link href="/sign-up">Create an account</Link>
      </Text>
    </Canvas>
  );
}
