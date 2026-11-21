import Link from "next/link";
import type { ReactNode } from "react";
import { SignOutButton } from "@/components/sign-out-button";

export const metadata = { title: "RMS maintainer console" };

// Unstyled on purpose: plain semantic HTML until the designer skins the console.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header>
          <p>RMS maintainer console</p>
          <nav aria-label="Console">
            <ul>
              <li>
                <Link href="/">Change feed</Link>
              </li>
              <li>
                <Link href="/queue">Review queue</Link>
              </li>
            </ul>
          </nav>
          <SignOutButton />
        </header>
        {children}
      </body>
    </html>
  );
}
