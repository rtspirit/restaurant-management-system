import type { Metadata } from "next";
import { OnboardingPreview } from "./preview";

export const metadata: Metadata = { title: "Gallery: onboarding questions" };

// The five onboarding questions with seeded answers, for review without signing in.
// /gallery/onboarding?step=3 opens on the third question. Nothing is sent anywhere.
export default async function GalleryOnboardingPage({ searchParams }: { searchParams: Promise<{ step?: string }> }) {
  const { step } = await searchParams;
  const start = Math.min(5, Math.max(1, Number.parseInt(step ?? "1", 10) || 1));
  return <OnboardingPreview start={start} />;
}
