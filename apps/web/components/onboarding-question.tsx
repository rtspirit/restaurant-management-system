"use client";
// The look of the five onboarding questions, one per screen. No logic lives here: the
// onboarding page (task A) owns the answers, the steps and the call to the API.
import type { FormEvent, Ref } from "react";
import type { OnboardingAnswers, ServiceStyle } from "@rms/contracts";
import { Button, Canvas, Choice, ChoiceList, Logo, Notice, QuestionForm, TextField } from "@rms/ui";

export const STYLES: { value: ServiceStyle; label: string }[] = [
  { value: "full_service", label: "Table service: guests order from a server" },
  { value: "counter_service", label: "Counter service: guests order at the counter" },
  { value: "quick_service", label: "Quick service or fast food" },
  { value: "bar", label: "Bar or pub" },
  { value: "cafe", label: "Café or coffee shop" },
  { value: "food_truck", label: "Food truck" },
];

export const SYSTEMS = ["Square", "Toast", "Clover", "Lightspeed", "QuickBooks", "Xero", "7shifts", "OpenTable"];

export const STEPS = 5;

// Each question is the heading of its screen, and takes focus when the step changes.
const QUESTIONS = [
  { title: "What is your restaurant called?", htmlFor: "restaurantName" },
  { title: "How do guests order?", group: true },
  { title: "What kind of food do you serve?", htmlFor: "cuisine", hint: "For example: Italian, pizza, Mexican, brunch.", hintId: "cuisine-hint" },
  { title: "How many locations do you have?", htmlFor: "locationCount" },
  { title: "Which of these do you use today?", group: true, hint: "Pick any that apply, or none." },
] as const;

export type OnboardingQuestionProps = {
  step: number;
  answers: OnboardingAnswers;
  set: <K extends keyof OnboardingAnswers>(key: K, value: OnboardingAnswers[K]) => void;
  error: string | null;
  busy: boolean;
  headingRef: Ref<HTMLHeadingElement>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onBack: () => void;
};

export function OnboardingQuestion({ step, answers, set, error, busy, headingRef, onSubmit, onBack }: OnboardingQuestionProps) {
  const question = QUESTIONS[step - 1] ?? QUESTIONS[0];

  return (
    <Canvas narrow header={<Logo />}>
      <QuestionForm
        step={step}
        of={STEPS}
        {...question}
        headingRef={headingRef}
        onSubmit={onSubmit}
        message={error ? <Notice kind="problem">{error}</Notice> : null}
        actions={
          <>
            {step > 1 ? (
              <Button size="l" onClick={onBack} disabled={busy}>
                Back
              </Button>
            ) : null}
            <Button type="submit" variant="primary" size="l" block busy={busy}>
              {step < STEPS ? "Next" : busy ? "Setting up your restaurant…" : "Finish"}
            </Button>
          </>
        }
      >
        {step === 1 ? (
          <TextField
            key="restaurantName"
            id="restaurantName"
            name="restaurantName"
            label="What is your restaurant called?"
            hideLabel
            autoComplete="organization"
            maxLength={80}
            required
            value={answers.restaurantName}
            onChange={(e) => set("restaurantName", e.target.value)}
          />
        ) : null}

        {step === 2 ? (
          <ChoiceList>
            {STYLES.map((s) => (
              <Choice
                key={s.value}
                type="radio"
                name="serviceStyle"
                value={s.value}
                label={s.label}
                required
                checked={answers.serviceStyle === s.value}
                onChange={() => set("serviceStyle", s.value)}
              />
            ))}
          </ChoiceList>
        ) : null}

        {step === 3 ? (
          <TextField
            key="cuisine"
            id="cuisine"
            name="cuisine"
            label="What kind of food do you serve?"
            hideLabel
            autoComplete="off"
            maxLength={60}
            required
            aria-describedby="cuisine-hint"
            value={answers.cuisine}
            onChange={(e) => set("cuisine", e.target.value)}
          />
        ) : null}

        {step === 4 ? (
          <TextField
            key="locationCount"
            id="locationCount"
            name="locationCount"
            label="How many locations do you have?"
            hideLabel
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
        ) : null}

        {step === 5 ? (
          <ChoiceList>
            {SYSTEMS.map((name) => (
              <Choice
                key={name}
                type="checkbox"
                name="systemsUsed"
                value={name}
                label={name}
                checked={answers.systemsUsed.includes(name)}
                onChange={(e) => set("systemsUsed", e.target.checked ? [...answers.systemsUsed, name] : answers.systemsUsed.filter((n) => n !== name))}
              />
            ))}
          </ChoiceList>
        ) : null}
      </QuestionForm>
    </Canvas>
  );
}
