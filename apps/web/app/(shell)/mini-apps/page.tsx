import type { Metadata } from "next";
import { BuildHome } from "@/components/build-home";
import { loadShellData } from "@/components/shell-data";

export const metadata: Metadata = { title: "Build a mini-app" };

export default async function BuildPage() {
  const data = await loadShellData();
  if (!data) return null; // The layout is showing something else (signing out, or not answering).
  return <BuildHome miniApps={data.miniApps} />;
}
