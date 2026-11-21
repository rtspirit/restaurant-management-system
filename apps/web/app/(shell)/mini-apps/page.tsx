import type { Metadata } from "next";
import { BuildHome } from "@/components/build-home";
import { loadShellData } from "@/components/shell-data";

export const metadata: Metadata = { title: "Build a mini-app" };

export default async function BuildPage() {
  const data = await loadShellData();
  return <BuildHome miniApps={data.miniApps} />;
}
