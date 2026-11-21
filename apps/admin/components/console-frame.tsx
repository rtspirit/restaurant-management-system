"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Canvas, CanvasHeader, Logo, TabLinks } from "@rms/ui";
import { SignOutButton } from "@/components/sign-out-button";

const PLACES = [
  { href: "/", label: "Change feed" },
  { href: "/queue", label: "Review queue" },
];

/**
 * The frame around every console page: the RMS mark, where you are, and sign out.
 * The console is for maintainers at a desk, so it runs in the compact density.
 */
export function ConsoleFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  // The sign-in page stands alone: a narrow column with nothing to navigate to yet.
  if (pathname === "/sign-in") {
    return (
      <Canvas narrow header={<CanvasHeader logo={<Logo />} title="Maintainer console" />}>
        {children}
      </Canvas>
    );
  }

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
