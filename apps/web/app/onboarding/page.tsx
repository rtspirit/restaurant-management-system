"use client";
// Five onboarding questions, one per step. The look lives in `@/components/onboarding-question`
// (built from @rms/ui only). The answers, the steps and the call to the API are here, unchanged.
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import type { OnboardingAnswers } from "@rms/contracts";
import { OnboardingQuestion, STEPS } from "@/components/onboarding-question";
import { SignedOutError, apiFetch, signOutAndGoToSignIn } from "@/lib/api";

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [answers, setAnswers] = useState<OnboardingAnswers>({
    restaurantName: "",
    serviceStyle: "full_service",
    cuisine: "",
    locationCount: 1,
    systemsUsed: [],
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const firstStep = useRef(true);

  // Move focus to the new question so screen readers and keyboards follow along.
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    heading.current?.focus();
  }, [step]);

  const set = <K extends keyof OnboardingAnswers>(key: K, value: OnboardingAnswers[K]) => setAnswers((a) => ({ ...a, [key]: value }));

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (step < STEPS) {
      setStep(step + 1);
      return;
    }
    setBusy(true);
    try {
      const res = await apiFetch("/auth/onboarding", {
        method: "POST",
        body: JSON.stringify({ ...answers, restaurantName: answers.restaurantName.trim(), cuisine: answers.cuisine.trim() }),
      });
      if (!res.ok) {
        setError(
          res.status === 400
            ? "Some answers are missing. Please go back and check them."
            : "We could not set up your restaurant just now. Please try again.",
        );
        return;
      }
      router.replace("/");
      router.refresh();
    } catch (e) {
      if (e instanceof SignedOutError) {
        await signOutAndGoToSignIn();
        return;
      }
      setError("We could not set up your restaurant just now. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <OnboardingQuestion
      step={step}
      answers={answers}
      set={set}
      error={error}
      busy={busy}
      headingRef={heading}
      onSubmit={onSubmit}
      onBack={() => setStep(step - 1)}
    />
  );
}
