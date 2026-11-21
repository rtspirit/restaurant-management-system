"use client";

import { useRef, useState, type FormEvent } from "react";
import type { OnboardingAnswers } from "@rms/contracts";
import { OnboardingQuestion, STEPS } from "@/components/onboarding-question";

/** The real onboarding screens with seeded answers. Next and Back work; Finish sends nothing. */
export function OnboardingPreview({ start }: { start: number }) {
  const [step, setStep] = useState(start);
  const [answers, setAnswers] = useState<OnboardingAnswers>({
    restaurantName: "Marigold Kitchen",
    serviceStyle: "full_service",
    cuisine: "Seasonal small plates",
    locationCount: 2,
    systemsUsed: ["Square"],
  });
  const heading = useRef<HTMLHeadingElement>(null);

  return (
    <OnboardingQuestion
      step={step}
      answers={answers}
      set={(key, value) => setAnswers((before) => ({ ...before, [key]: value }))}
      error={null}
      busy={false}
      headingRef={heading}
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (step < STEPS) setStep(step + 1);
      }}
      onBack={() => setStep(step - 1)}
    />
  );
}
