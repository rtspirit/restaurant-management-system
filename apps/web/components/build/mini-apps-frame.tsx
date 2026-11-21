"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { MiniAppsPage } from "@/components/mini-apps-page";

/** The Mini-apps area. The build screen draws edge to edge, right up to the tabs. Everything else keeps its space. */
export function MiniAppsFrame({ children }: { children: ReactNode }) {
  const building = usePathname().startsWith("/mini-apps/build/");
  return <MiniAppsPage flush={building}>{children}</MiniAppsPage>;
}
