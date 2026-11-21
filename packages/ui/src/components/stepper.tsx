import { Icon } from "../icons";

export type StepState = "done" | "now" | "todo";

export type StepperStep = {
  id: string;
  /** What is happening, in the owner's words: "Checking the numbers add up". */
  label: string;
  state: StepState;
};

export type StepperProps = {
  /** Names the list for screen readers: "Progress". */
  label: string;
  steps: StepperStep[];
  /** The word shown for each state. Change these only to translate. */
  words?: Record<StepState, string>;
};

const WORDS: Record<StepState, string> = { done: "Done", now: "In progress", todo: "Not started" };

/**
 * Progress as shapes plus words: a solid ink disc with a tick is done, an open turning
 * ring is in progress, a hollow ring has not started. Never colour.
 */
export function Stepper({ label, steps, words = WORDS }: StepperProps) {
  return (
    <ol className="rms-stepper" aria-label={label}>
      {steps.map((step) => (
        <li key={step.id} className="rms-step" data-state={step.state} aria-current={step.state === "now" ? "step" : undefined}>
          <span className="rms-step__mark" aria-hidden="true">
            {step.state === "done" ? <Icon name="check" /> : null}
          </span>
          {step.label}
          <span className="rms-step__state">{words[step.state]}</span>
        </li>
      ))}
    </ol>
  );
}
