"use client";
// Five onboarding questions, one per step. The look lives in `@/components/onboarding-question`
// (built from @rms/ui only). The answers, the steps and the call to the API are here, unchanged.
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import type { OnboardingAnswers } from "@rms/contracts";
import { OnboardingQuestion, STEPS } from "@/components/onboarding-question";
import { SignedOutError, apiFetch, signOutAndGoToSignIn } from "@/lib/api";

const COULD_NOT_SET_UP = "We could not set up your restaurant just now. Please try again.";

/**
 * The API's own words for a refusal, when the answer carries them in the agreed shape:
 * { error: { code, message, requestId } }, where `message` is written for an owner to read
 * ("We are not taking new restaurants right now."). Anything else gives null, and the page
 * says its own plain line. A message that reads like a program wrote it is never shown:
 * only short sentences made of letters, figures and everyday punctuation pass, and nothing
 * with a code word, a dotted name, an id or the name of an error in it.
 */
async function ownerMessage(res: Response): Promise<string | null> {
  const body: unknown = await res.json().catch(() => null);
  const error = body !== null && typeof body === "object" && "error" in body ? (body as { error: unknown }).error : null;
  if (error === null || typeof error !== "object") return null;
  const { code, message, requestId } = error as { code?: unknown; message?: unknown; requestId?: unknown };
  if (typeof code !== "string" || typeof message !== "string" || typeof requestId !== "string") return null;
  const words = message.trim();
  const sentences = /^[A-Za-z0-9 .,'’!?()-]{1,160}$/.test(words);
  const programWords = /error|exception|undefined|null|\bNaN\b|stack|[a-z0-9]_[a-z0-9]|\w\.\w|[0-9a-f]{8}-[0-9a-f]{4}/i.test(words);
  return sentences && !programWords ? words : null;
}

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
        // The page's own line for answers it can point at. Otherwise the API's words, and the plain line when it sent none.
        setError(res.status === 400 ? "Some answers are missing. Please go back and check them." : ((await ownerMessage(res)) ?? COULD_NOT_SET_UP));
        return;
      }
      router.replace("/");
      router.refresh();
    } catch (e) {
      if (e instanceof SignedOutError) {
        await signOutAndGoToSignIn();
        return;
      }
      setError(COULD_NOT_SET_UP);
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
