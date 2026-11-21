"use client";
// Five onboarding questions, one per step. Unstyled on purpose: the designer skins this later.
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import type { OnboardingAnswers, ServiceStyle } from "@rms/contracts";
import { SignedOutError, apiFetch } from "@/lib/api";

const STYLES: { value: ServiceStyle; label: string }[] = [
  { value: "full_service", label: "Table service: guests order from a server" },
  { value: "counter_service", label: "Counter service: guests order at the counter" },
  { value: "quick_service", label: "Quick service or fast food" },
  { value: "bar", label: "Bar or pub" },
  { value: "cafe", label: "Café or coffee shop" },
  { value: "food_truck", label: "Food truck" },
];

const SYSTEMS = ["Square", "Toast", "Clover", "Lightspeed", "QuickBooks", "Xero", "7shifts", "OpenTable"];

const STEPS = 5;

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
        router.replace("/sign-in");
        return;
      }
      setError("We could not set up your restaurant just now. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <p>
        Question {step} of {STEPS}
      </p>
      <form onSubmit={onSubmit}>
        {step === 1 ? (
          <>
            <h1 ref={heading} tabIndex={-1}>
              <label htmlFor="restaurantName">What is your restaurant called?</label>
            </h1>
            <input
              id="restaurantName"
              name="restaurantName"
              autoComplete="organization"
              maxLength={80}
              required
              value={answers.restaurantName}
              onChange={(e) => set("restaurantName", e.target.value)}
            />
          </>
        ) : null}

        {step === 2 ? (
          <fieldset>
            <legend>
              <h1 ref={heading} tabIndex={-1}>
                How do guests order?
              </h1>
            </legend>
            {STYLES.map((s) => (
              <p key={s.value}>
                <label>
                  <input
                    type="radio"
                    name="serviceStyle"
                    value={s.value}
                    required
                    checked={answers.serviceStyle === s.value}
                    onChange={() => set("serviceStyle", s.value)}
                  />{" "}
                  {s.label}
                </label>
              </p>
            ))}
          </fieldset>
        ) : null}

        {step === 3 ? (
          <>
            <h1 ref={heading} tabIndex={-1}>
              <label htmlFor="cuisine">What kind of food do you serve?</label>
            </h1>
            <p id="cuisine-hint">For example: Italian, pizza, Mexican, brunch.</p>
            <input
              id="cuisine"
              name="cuisine"
              autoComplete="off"
              maxLength={60}
              required
              aria-describedby="cuisine-hint"
              value={answers.cuisine}
              onChange={(e) => set("cuisine", e.target.value)}
            />
          </>
        ) : null}

        {step === 4 ? (
          <>
            <h1 ref={heading} tabIndex={-1}>
              <label htmlFor="locationCount">How many locations do you have?</label>
            </h1>
            <input
              id="locationCount"
              name="locationCount"
              type="number"
              inputMode="numeric"
              autoComplete="off"
              min={1}
              max={50}
              step={1}
              required
              value={answers.locationCount}
              onChange={(e) => set("locationCount", Number(e.target.value))}
            />
          </>
        ) : null}

        {step === 5 ? (
          <fieldset>
            <legend>
              <h1 ref={heading} tabIndex={-1}>
                Which of these do you use today?
              </h1>
            </legend>
            <p>Pick any that apply, or none.</p>
            {SYSTEMS.map((name) => (
              <p key={name}>
                <label>
                  <input
                    type="checkbox"
                    name="systemsUsed"
                    value={name}
                    checked={answers.systemsUsed.includes(name)}
                    onChange={(e) =>
                      set("systemsUsed", e.target.checked ? [...answers.systemsUsed, name] : answers.systemsUsed.filter((n) => n !== name))
                    }
                  />{" "}
                  {name}
                </label>
              </p>
            ))}
          </fieldset>
        ) : null}

        {error ? <p role="alert">{error}</p> : null}

        <p>
          {step > 1 ? (
            <button type="button" onClick={() => setStep(step - 1)} disabled={busy}>
              Back
            </button>
          ) : null}{" "}
          <button type="submit" disabled={busy}>
            {step < STEPS ? "Next" : busy ? "Setting up your restaurant…" : "Finish"}
          </button>
        </p>
      </form>
    </main>
  );
}
