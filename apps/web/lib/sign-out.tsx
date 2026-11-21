"use client";
import { useEffect } from "react";
import { signOutAndGoToSignIn } from "./api";

/** A plain sign-out control. Posts to /sign-out, which clears the session and goes to sign-in. */
export function SignOutForm() {
  return (
    <form action="/sign-out" method="post">
      <button type="submit">Sign out</button>
    </form>
  );
}

/**
 * Render this when the server found a session cookie but the API refused it (`getMe()` returned
 * null on a page behind sign-in). It signs out and goes to sign-in instead of looping.
 */
export function SignOutNow() {
  useEffect(() => {
    void signOutAndGoToSignIn();
  }, []);
  return <p role="status">Signing you out…</p>;
}
