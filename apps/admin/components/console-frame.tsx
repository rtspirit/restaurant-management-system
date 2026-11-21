"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { Button, Canvas, CanvasHeader, Heading, Logo, Row, Skeleton, TabLinks, Text } from "@rms/ui";
import { SignOutButton } from "@/components/sign-out-button";
import { ApiError, apiFetch } from "@/lib/api";

const PLACES = [
  { href: "/", label: "Change feed" },
  { href: "/queue", label: "Review queue" },
];

/**
 * What the API said about the person signed in.
 * Nothing of the console is drawn until it has said "maintainer": no navigation, no filters, no tier names.
 */
type Access = "checking" | "maintainer" | "refused" | "signed-out" | "unreachable";

/**
 * The frame around every console page: the RMS mark, where you are, and sign out.
 * The console is for maintainers at a desk, so it runs in the compact density.
 *
 * The API decides who is a maintainer, on every call. The frame asks it once before it draws
 * anything, so someone who is not a maintainer sees only a plain refusal and a way to sign out,
 * and the pages inside (which load the feed and the queue) are never started for them.
 */
export function ConsoleFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const onSignIn = pathname === "/sign-in";
  const [access, setAccess] = useState<Access>("checking");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setAccess("checking");
    // Nobody is signed in on the sign-in page. Asking starts again once they are.
    if (onSignIn) return;
    let current = true;
    // STUB: the API has no "who am I" route for the console yet, so this asks for the review queue,
    // which a maintainer may read and anyone else is refused (403, with nothing in the answer).
    apiFetch("/admin/queue").then(
      () => {
        if (current) setAccess("maintainer");
      },
      (e: unknown) => {
        if (!current) return;
        const status = e instanceof ApiError ? e.status : 0;
        setAccess(status === 403 ? "refused" : status === 401 ? "signed-out" : "unreachable");
      },
    );
    return () => {
      current = false;
    };
  }, [onSignIn, attempt]);

  // The sign-in page stands alone: a narrow column with nothing to navigate to yet.
  if (onSignIn) {
    return (
      <Canvas narrow header={<CanvasHeader logo={<Logo />} title="Maintainer console" />}>
        {children}
      </Canvas>
    );
  }

  if (access === "maintainer") {
    return (
      <Canvas
        header={
          <CanvasHeader
            logo={<Logo href="/" linkAs={Link} label="RMS maintainer console, change feed" />}
            title="Maintainer console"
            nav={<TabLinks label="Console" linkAs={Link} items={PLACES.map((place) => ({ ...place, current: place.href === pathname }))} />}
            end={<SignOutButton />}
          />
        }
      >
        {children}
      </Canvas>
    );
  }

  // Everyone else: the mark, one plain message and the way out. Nothing that says what is inside.
  return (
    <Canvas narrow header={<Logo />}>
      {access === "checking" ? <Skeleton width="m" label="Checking your account" /> : null}
      {access === "refused" ? (
        <>
          <Heading level={1} size="page">
            This account is not a maintainer.
          </Heading>
          <Text>Sign out, then sign in with a maintainer account.</Text>
          <div>
            <SignOutButton variant="primary" />
          </div>
        </>
      ) : null}
      {access === "signed-out" ? (
        <>
          <Heading level={1} size="page">
            Please sign in again
          </Heading>
          <Text>You were signed out. Nothing has been lost.</Text>
          <div>
            <SignOutButton variant="primary" label="Go to sign-in" />
          </div>
        </>
      ) : null}
      {access === "unreachable" ? (
        <>
          <Heading level={1} size="page">
            RMS is not answering just now
          </Heading>
          <Text>Nothing has been lost. Give it a moment, then try again.</Text>
          <Row>
            <Button variant="primary" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
            <SignOutButton />
          </Row>
        </>
      ) : null}
    </Canvas>
  );
}
