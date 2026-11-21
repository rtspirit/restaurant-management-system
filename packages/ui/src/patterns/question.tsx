import type { FormEvent, ReactNode, Ref } from "react";

export type QuestionFormProps = {
  /** Which question this is, counting from 1. */
  step: number;
  /** How many questions there are. */
  of: number;
  /** Words for the progress line. Defaults to "Question 2 of 5". */
  progressLabel?: string;
  /** The question itself. It is the page's heading. */
  title: string;
  /** For a single text or number field: the id of that field, so the question is its label. */
  htmlFor?: string;
  /** For radio or checkbox answers: wraps them in a group named by the question. */
  group?: boolean;
  /** One short line under the question. Give `hintId` to tie it to a field. */
  hint?: string;
  hintId?: string;
  /** Lets the page move focus to the question when the step changes. */
  headingRef?: Ref<HTMLHeadingElement>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  /** The answer: one field, or a ChoiceList. */
  children: ReactNode;
  /** A Notice, when something went wrong. */
  message?: ReactNode;
  /** Buttons. Put the main one last. */
  actions: ReactNode;
};

/**
 * Pattern: one question per screen. A progress line, the question as the heading, the
 * answer, then Back and Next. Built for a phone held in one hand.
 */
export function QuestionForm({ step, of, progressLabel, title, htmlFor, group = false, hint, hintId, headingRef, onSubmit, children, message, actions }: QuestionFormProps) {
  const progress = progressLabel ?? `Question ${step} of ${of}`;
  const heading = (
    <h1 className="rms-heading rms-heading--page rms-question__title" ref={headingRef} tabIndex={-1}>
      {htmlFor ? <label htmlFor={htmlFor}>{title}</label> : title}
    </h1>
  );
  const hintLine = hint ? (
    <p className="rms-text rms-text--muted" id={hintId}>
      {hint}
    </p>
  ) : null;

  return (
    <form className="rms-form rms-question" onSubmit={onSubmit}>
      <div className="rms-question__progress">
        <p className="rms-question__count">{progress}</p>
        <progress className="rms-progress" max={of} value={step} aria-label={progress} />
      </div>
      {group ? (
        <fieldset className="rms-field-group rms-question__body">
          <legend className="rms-field-group__legend">{heading}</legend>
          {hintLine}
          {children}
        </fieldset>
      ) : (
        <div className="rms-question__body">
          {heading}
          {hintLine}
          {children}
        </div>
      )}
      {message}
      <div className="rms-form__actions">{actions}</div>
    </form>
  );
}
