import { useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { cx } from "../cx";
import { Icon } from "../icons";

type NativeChoice = Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "style" | "children" | "type">;

export type ChoiceProps = NativeChoice & {
  /** radio: pick one of several. checkbox: pick any. */
  type: "radio" | "checkbox";
  /** What this choice means, in plain words. The whole row can be pressed. */
  label: string;
};

/**
 * One answer the owner can pick: a 48px row with the platform's own radio or checkbox.
 * The chosen row gets a heavier ink edge as well as its tick, so it is clear at arm's length.
 */
export function Choice({ type, label, ...rest }: ChoiceProps) {
  return (
    <label className="rms-choice">
      <input {...rest} type={type} className="rms-choice__input" />
      <span>{label}</span>
    </label>
  );
}

export type ChoiceListProps = {
  /** Choice components. */
  children: ReactNode;
};

/** Stacks Choice rows with the right space between them. */
export function ChoiceList({ children }: ChoiceListProps) {
  return <div className="rms-choices">{children}</div>;
}

type NativeTextArea = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className" | "style" | "children">;

export type TextAreaProps = NativeTextArea & {
  label: string;
  hint?: string;
};

/** A few lines of free text, such as a note. */
export function TextArea({ label, hint, id, rows = 2, ...rest }: TextAreaProps) {
  const auto = useId();
  const fieldId = id ?? auto;
  const hintId = hint ? `${fieldId}-hint` : undefined;
  return (
    <div className="rms-field">
      <label className="rms-field__label" htmlFor={fieldId}>
        {label}
      </label>
      {hint ? (
        <span className="rms-field__hint" id={hintId}>
          {hint}
        </span>
      ) : null}
      <textarea {...rest} id={fieldId} rows={rows} className="rms-input rms-input--area" aria-describedby={hintId} />
    </div>
  );
}

export type FieldGroupProps = {
  /** Names the group for screen readers and, unless hidden, on screen. */
  legend: string;
  hideLegend?: boolean;
  /** Switches off everything inside at once, for example while a decision is being saved. */
  disabled?: boolean;
  children: ReactNode;
};

/** Fields and buttons that belong to one decision. */
export function FieldGroup({ legend, hideLegend = false, disabled, children }: FieldGroupProps) {
  return (
    <fieldset className="rms-field-group" disabled={disabled}>
      <legend className={cx("rms-field-group__legend", hideLegend && "rms-sr-only")}>{legend}</legend>
      {children}
    </fieldset>
  );
}

export type NoticeProps = {
  /**
   * problem: something went wrong, said in plain words with what to do next (announced at once).
   * status: something happened or is happening (announced politely).
   */
  kind: "problem" | "status";
  children: ReactNode;
};

/**
 * A message about the whole form or page. A problem is an ink outline with an ink mark,
 * never a colour. A status is a quiet label.
 */
export function Notice({ kind, children }: NoticeProps) {
  return (
    <p className={cx("rms-notice", `rms-notice--${kind}`)} role={kind === "problem" ? "alert" : "status"}>
      {kind === "problem" ? <Icon name="alert" /> : null}
      <span>{children}</span>
    </p>
  );
}
