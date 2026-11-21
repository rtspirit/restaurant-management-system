import type { ReactNode } from "react";
import { MiniAppsPage } from "@/components/mini-apps-page";

export default function MiniAppsLayout({ children }: { children: ReactNode }) {
  return <MiniAppsPage>{children}</MiniAppsPage>;
}
