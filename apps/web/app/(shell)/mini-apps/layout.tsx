import type { ReactNode } from "react";
import { MiniAppsFrame } from "@/components/build/mini-apps-frame";

export default function MiniAppsLayout({ children }: { children: ReactNode }) {
  return <MiniAppsFrame>{children}</MiniAppsFrame>;
}
