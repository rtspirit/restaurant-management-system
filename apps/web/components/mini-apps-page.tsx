"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Page, TabLinks } from "@rms/ui";

const TABS = [
  { href: "/mini-apps", label: "Build" },
  { href: "/mini-apps/marketplace", label: "Marketplace" },
];

export type MiniAppsPageProps = {
  /** Which tab is open. Worked out from the address when left out. */
  current?: "/mini-apps" | "/mini-apps/marketplace";
  /** The content draws right up to the tabs (the build screen). */
  flush?: boolean;
  children: ReactNode;
};

/** The Mini-apps area: one title, two tabs. Build makes a mini-app, Marketplace installs one. */
export function MiniAppsPage({ current, flush = false, children }: MiniAppsPageProps) {
  const pathname = usePathname();
  const open = current ?? (pathname.startsWith("/mini-apps/marketplace") ? "/mini-apps/marketplace" : "/mini-apps");

  return (
    <Page
      title="Mini-apps"
      flush={flush}
      tabs={<TabLinks label="Mini-apps" linkAs={Link} items={TABS.map((tab) => ({ ...tab, current: tab.href === open }))} />}
    >
      {children}
    </Page>
  );
}
