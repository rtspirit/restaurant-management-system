import type { ReactNode } from "react";
import { RmsShell } from "@/components/rms-shell";
import { loadShellData } from "@/components/shell-data";

// Every signed-in RMS screen sits inside this frame.
export default async function ShellLayout({ children }: { children: ReactNode }) {
  const data = await loadShellData();
  return <RmsShell data={data}>{children}</RmsShell>;
}
