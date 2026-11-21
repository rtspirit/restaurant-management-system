"use client";
// Skinned with @rms/ui only. The sign-up logic is task A's and is unchanged.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button, Canvas, FormLayout, Heading, Logo, Notice, Text, TextField } from "@rms/ui";
import { createClient } from "@/lib/supabase/client";

const MIN_PASSWORD = 8;

export default function SignUpPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The two passwords differ: said at the second box, where it is fixed, not above the button.
  const [mismatch, setMismatch] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    if (password !== String(form.get("confirm") ?? "")) {
      setError(null);
      setMismatch(true);
      return;
    }
    setMismatch(false);
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
    <Canvas narrow header={<Logo />}>
      {notice ? (
        <>
          <Heading level={1} size="page">
            Create your account
          </Heading>
          <Notice kind="status">{notice}</Notice>
        </>
      ) : (
        <FormLayout
          title="Create your account"
          titleLevel={1}
          onSubmit={onSubmit}
          message={error ? <Notice kind="problem">{error}</Notice> : null}
          actions={
            <Button type="submit" variant="primary" size="l" block busy={busy}>
              {busy ? "Creating your account…" : "Create account"}
            </Button>
          }
        >
          <TextField id="email" name="email" type="email" label="Email" autoComplete="email" required />
          <TextField
            id="password"
            name="password"
            type="password"
            label="Password"
            hint={`At least ${MIN_PASSWORD} characters.`}
            autoComplete="new-password"
            minLength={MIN_PASSWORD}
            required
          />
          <TextField
            id="confirm"
            name="confirm"
            type="password"
            label="Type the password again"
            autoComplete="new-password"
            minLength={MIN_PASSWORD}
            required
            {...(mismatch ? { error: "The two passwords are not the same. Type the same password in both boxes." } : {})}
            onChange={() => setMismatch(false)}
          />
        </FormLayout>
      )}
      <Text>
        Already have an account? <Link href="/sign-in">Sign in</Link>
      </Text>
    </Canvas>
  );
}
